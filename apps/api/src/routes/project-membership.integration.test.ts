// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { MongoClient, type Db } from "mongodb";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStore, type ProjectDocument, type UserDocument } from "shared";
import { Authorization } from "../auth/authorization.js";
import { AccessError, AdminOperations, type AdminOperation } from "../auth/admin-operations.js";
import { registerAccessRoutes } from "./access.js";

const uri = process.env.AUTH_TEST_MONGO_URI;
describe.runIf(Boolean(uri))("Project-admin membership routes with canonical authority and durable writes", () => {
  const database = `project-member-test-${randomUUID()}`;
  let projectId: string, otherProject: string, adminId: string, platformId: string, targetId: string;
  const app = express();
  let client: MongoClient;
  let db: Db;
  let operations: AdminOperations;
  let authority: Authorization;

  beforeAll(async () => {
    if (!uri) throw new Error("AUTH_TEST_MONGO_URI is required");
    client = await new MongoClient(uri).connect();
    db = client.db(database);
    operations = new AdminOperations(db);
    authority = new Authorization(db);
    await db.collection("project_memberships").createIndex({ projectId: 1, userId: 1 }, { unique: true });
    app.use(express.json());
    app.use((req, _res, next) => {
      const actor = req.get("X-Test-Verified-Actor") ?? adminId;
      // This harness starts AFTER bearer verification; canonical authority is real.
      req.user = { id: actor, role: "user", isAuthenticated: true };
      req.auth = {
        token: `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url")}.signature`,
      };
      next();
    });
    app.locals.authorization = () => authority;
    registerAccessRoutes({
      app, registry: new OpenAPIRegistry(), db, usersCollection: db.collection<UserDocument>("users"),
      projectStore: new ProjectStore(db.collection<ProjectDocument>("projects")),
    });
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error instanceof AccessError ? error.status : 500).json({
        error: error.message, code: error instanceof AccessError ? error.code : "unexpected",
      });
    });
  });
  beforeEach(async () => {
    projectId = randomUUID(); otherProject = randomUUID();
    adminId = randomUUID(); platformId = randomUUID(); targetId = randomUUID();
    const now = new Date();
    await db.collection<UserDocument>("users").insertMany([
      { _id: adminId, idp: "entra", idpTenant: "fixture", idpSubject: adminId, role: "user", createdAt: now, updatedAt: now },
      { _id: platformId, idp: "entra", idpTenant: "fixture", idpSubject: platformId, role: "admin", createdAt: now, updatedAt: now },
      { _id: targetId, idp: "entra", idpTenant: "fixture", idpSubject: targetId, role: "user", displayName: "Enrolled target", createdAt: now, updatedAt: now },
    ]);
    await db.collection("projects").insertMany([{ _id: projectId, name: "Project A" }, { _id: otherProject, name: "Project B" }]);
    await grant(adminId, "admin", 0);
  });
  afterAll(async () => { if (db) await db.dropDatabase(); await client?.close(); });
  afterEach(() => vi.restoreAllMocks());

  function grant(userId: string, role: "reader" | "contributor" | "admin", revision: number) {
    return operations.execute({
      _id: randomUUID(), actor: platformId, reason: "Isolated membership fixture",
      collection: "project_memberships", targetId: `${projectId}:${userId}`, expectedRevision: revision,
      change: { role }, unset: ["revokedAt"], initial: { projectId, userId, createdByUserId: platformId },
    });
  }
  const memberPath = (userId = targetId, id = projectId) => `/api/v1/projects/${id}/members/${userId}`;

  it("adds a new enrolled user, edits every fixed role and revokes without changing identity or platform role", async () => {
    const before = await db.collection<UserDocument>("users").findOne({ _id: targetId });
    const lookup = await request(app).get(`/api/v1/projects/${projectId}/members/lookup/${targetId}`);
    expect(lookup.status).toBe(200);
    expect(lookup.headers["cache-control"]).toBe("no-store");
    expect(lookup.body).toEqual({ id: targetId, displayName: "Enrolled target", role: "user", disabled: false, revision: 0 });
    expect(lookup.body).not.toHaveProperty("idpSubject");
    let revision = 0;
    for (const role of ["reader", "contributor", "admin"]) {
      const id = randomUUID();
      const result = await request(app).put(memberPath()).set("Idempotency-Key", id).send({ role, revision });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ operationId: id, state: "completed", revision: ++revision });
      const replay = await request(app).put(memberPath()).set("Idempotency-Key", id).send({ role, revision: revision - 1 });
      expect(replay.body).toEqual(result.body);
      const evidence = await db.collection<AdminOperation>("admin_operations").findOne({ _id: id });
      expect(evidence).toMatchObject({
        actor: adminId, reason: "Explicit project-admin membership assignment", collection: "project_memberships",
        targetId: `${projectId}:${targetId}`, state: "completed", expectedRevision: revision - 1, change: { role },
      });
    }
    const roster = await request(app).get(`/api/v1/projects/${projectId}/members`);
    expect(roster.status).toBe(200);
    expect(roster.body).toEqual(expect.arrayContaining([expect.objectContaining({ userId: targetId, role: "admin", revision: 3, pending: false })]));
    const revokeId = randomUUID();
    expect((await request(app).delete(memberPath()).set("Idempotency-Key", revokeId).send({ revision })).status).toBe(200);
    expect(await db.collection<AdminOperation>("admin_operations").findOne({ _id: revokeId })).toMatchObject({
      actor: adminId, reason: "Explicit project-admin membership revocation", state: "completed",
    });
    expect(await authority.memberships(targetId)).toEqual([]);
    expect(await db.collection<UserDocument>("users").findOne({ _id: targetId })).toEqual(before);
    expect(await db.collection("project_memberships").countDocuments({ projectId: otherProject })).toBe(0);
  });

  it("returns 404 for foreign projects and 403 for readers/contributors before roster or target discovery", async () => {
    for (const [path, method] of [
      [`/api/v1/projects/${otherProject}/members`, "get"],
      [`/api/v1/projects/${otherProject}/members/search?q=Enrolled`, "get"],
      [`/api/v1/projects/${otherProject}/members/lookup/${targetId}`, "get"],
      [memberPath(targetId, otherProject), "put"], [memberPath(targetId, otherProject), "delete"],
    ] as const) {
      expect((await request(app)[method](path).send({ role: "admin", revision: 0 })).status).toBe(404);
    }
    let revision = 0;
    for (const role of ["reader", "contributor"] as const) {
      expect((await grant(targetId, role, revision++)).state).toBe("completed");
      for (const [path, method] of [
        [`/api/v1/projects/${projectId}/members`, "get"],
        [`/api/v1/projects/${projectId}/members/search?q=Enrolled`, "get"],
        [`/api/v1/projects/${projectId}/members/lookup/${randomUUID()}`, "get"],
        [memberPath(), "put"], [memberPath(), "delete"],
      ] as const) {
        expect((await request(app)[method](path).set("X-Test-Verified-Actor", targetId).send({ role: "admin", revision: revision })).status).toBe(403);
      }
    }
    for (const path of ["/api/v1/admin/users/search", "/api/v1/admin/users", "/api/v1/admin/platform-admins"]) {
      expect((await request(app).get(path)).status).toBe(403);
    }
  });

  it("searches minimal enrolled-user summaries by name, email, alias and Scope UUID with bounded literal pagination", async () => {
    const prefix = `Member search ${randomUUID()}`;
    const now = new Date();
    const candidates: UserDocument[] = ["Alice", "Bob.*[", "Disabled"].map((name, index) => ({
      _id: randomUUID(), idp: "entra", idpTenant: "fixture", idpSubject: randomUUID(), role: "user",
      displayName: `${prefix} ${name}`, email: `${index}-${prefix}@example.test`, alias: `${prefix}-${index}`,
      ...(index === 2 ? { disabledAt: now } : {}), createdAt: now, updatedAt: now,
    }));
    await db.collection<UserDocument>("users").insertMany(candidates);
    const path = `/api/v1/projects/${projectId}/members/search`;
    const first = await request(app).get(path).query({ q: prefix.toUpperCase(), limit: 2 });
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app).get(path).query({ q: prefix, limit: 2, cursor: first.body.nextCursor });
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeUndefined();
    const items: { id: string; disabled: boolean }[] = [...first.body.items, ...second.body.items];
    expect(new Set(items.map(user => user.id))).toEqual(new Set(candidates.map(user => user._id)));
    expect(items.find(user => user.id === candidates[2]._id)?.disabled).toBe(true);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["alias", "disabled", "displayName", "email", "id", "revision", "role"]);
    }
    for (const q of [candidates[0].email, candidates[0].alias, candidates[0]._id]) {
      const result = await request(app).get(path).query({ q });
      expect(result.status).toBe(200);
      expect(result.body.items.map((user: { id: string }) => user.id)).toEqual([candidates[0]._id]);
    }
    const literal = await request(app).get(path).query({ q: `${prefix} Bob.*[` });
    expect(literal.status).toBe(200);
    expect(literal.body.items.map((user: { id: string }) => user.id)).toEqual([candidates[1]._id]);
    const missing = await request(app).get(path).query({ q: randomUUID() });
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({ items: [] });
    for (const query of [{ limit: 0 }, { limit: 51 }, { q: "x".repeat(101) }, { cursor: "" }, { role: "admin" }]) {
      expect((await request(app).get(path).query(query)).status).toBe(400);
    }
    expect((await request(app).get(path).set("X-Test-Verified-Actor", platformId)).status).toBe(200);
    expect((await request(app).get(`/api/v1/projects/${otherProject}/members/search`).query({ q: "x".repeat(101) })).status).toBe(404);
    expect((await request(app).put(memberPath(adminId)).send({ role: "reader", revision: 1 })).status).toBe(200);
    expect((await request(app).get(path)).status).toBe(403);
  });

  it("rejects tampered fields, unenrolled/disabled targets and stale revisions without a grant", async () => {
    await grant(targetId, "reader", 0);
    for (const extra of [{ projectId: otherProject }, { userId: platformId }, { platformRole: "admin" }, { permissions: ["*"] }, { role: "owner" }]) {
      expect((await request(app).put(memberPath()).send({ role: "admin", revision: 1, ...extra })).status).toBe(400);
    }
    expect((await request(app).put(memberPath()).send({ role: "admin", revision: 0 })).status).toBe(409);
    const missing = randomUUID();
    expect((await request(app).get(`/api/v1/projects/${projectId}/members/lookup/${missing}`)).status).toBe(404);
    expect((await request(app).put(memberPath(missing)).send({ role: "admin", revision: 0 })).status).toBe(404);
    expect(await db.collection("users").findOne({ _id: missing })).toBeNull();
    await db.collection<UserDocument>("users").updateOne({ _id: targetId }, { $set: { disabledAt: new Date() } });
    expect((await request(app).get(`/api/v1/projects/${projectId}/members/lookup/${targetId}`)).status).toBe(409);
    expect((await request(app).put(memberPath()).send({ role: "admin", revision: 1 })).status).toBe(409);
    await db.collection<UserDocument>("users").updateOne({ _id: targetId }, { $unset: { disabledAt: "" } });
  });

  it("allows self-demotion and removal without a last-admin rule and immediately removes management authority", async () => {
    expect((await request(app).put(memberPath(adminId)).send({ role: "reader", revision: 1 })).status).toBe(200);
    expect((await request(app).get(`/api/v1/projects/${projectId}/members`)).status).toBe(403);
    expect((await grant(adminId, "admin", 2)).state).toBe("completed");
    expect((await request(app).delete(memberPath(adminId)).send({ revision: 3 })).status).toBe(200);
    expect((await request(app).get(`/api/v1/projects/${projectId}/members`)).status).toBe(404);
    const roster = await request(app).get(`/api/v1/projects/${projectId}/members`).set("X-Test-Verified-Actor", platformId);
    expect(roster.status).toBe(200);
    expect((await request(app).put(memberPath(adminId)).set("X-Test-Verified-Actor", platformId).send({ role: "admin", revision: 4 })).status).toBe(200);
    expect((await request(app).get(`/api/v1/projects/${projectId}/members`)).status).toBe(200);
  });

  it("retains the project actor and exact intent through pending completion and same-key retry without HTTP recovery", async () => {
    const id = randomUUID(), enrolled = randomUUID(), now = new Date();
    await db.collection<UserDocument>("users").insertOne({
      _id: enrolled, idp: "entra", idpTenant: "fixture", idpSubject: enrolled, role: "user", createdAt: now, updatedAt: now,
    });
    const collection = db.collection.bind(db);
    const evidence = collection<AdminOperation>("admin_operations");
    vi.spyOn(db, "collection").mockImplementation(name => name === "admin_operations" ? evidence : collection(name));
    const update = vi.spyOn(evidence, "updateOne").mockRejectedValueOnce(new Error("Injected completion failure"));
    const pending = await request(app).put(memberPath(enrolled)).set("Idempotency-Key", id).send({ role: "admin", revision: 0 });
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ state: "pending", operationId: id });
    expect(await authority.memberships(enrolled)).toEqual([]);
    expect(await evidence.findOne({ _id: id })).toMatchObject({ actor: adminId, state: "prepared", change: { role: "admin" } });
    update.mockRestore();
    expect((await request(app).put(memberPath(enrolled)).set("Idempotency-Key", id).send({ role: "reader", revision: 0 })).status).toBe(409);
    const retry = await request(app).put(memberPath(enrolled)).set("Idempotency-Key", id).send({ role: "admin", revision: 0 });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ operationId: id, revision: 1, state: "completed" });
    expect((await authority.memberships(enrolled)).map(m => m.role)).toEqual(["admin"]);
    expect((await request(app).post(`/api/v1/admin/operations/${id}/reconcile`).send({})).status).toBe(404);
    expect((await request(app).post(`/api/v1/admin/operations/${id}/reconcile`).set("X-Test-Verified-Actor", platformId).send({})).status).toBe(404);
    expect((await request(app).get(`/api/v1/admin/operations/${id}`).set("X-Test-Verified-Actor", platformId)).status).toBe(404);
    expect(await evidence.findOne({ _id: id })).toMatchObject({ actor: adminId, state: "completed" });
  });
});
