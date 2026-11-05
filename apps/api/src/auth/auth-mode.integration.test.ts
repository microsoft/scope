// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectStore, type ProjectDocument } from "shared";
import { app, _injectTestDependencies } from "../index.js";
import { createAllMockDependencies } from "../test-helpers.js";

vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({ ready: true, applied: [], pending: [] }),
}));
vi.mock("../llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false), generateCriteriaPrompt: vi.fn(),
}));
vi.mock("../prompt-feature-llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
  generatePromptFeaturePrompt: vi.fn(), extractPromptFeatures: vi.fn(),
}));
vi.mock("../task-prompt-llm.js", () => ({
  isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false), generateTaskPrompt: vi.fn(),
}));

const uri = process.env.AUTH_TEST_MONGO_URI;
describe.runIf(Boolean(uri))("Explicit anonymous deployment mode with native Mongo", () => {
  const database = `auth-mode-test-${randomUUID()}`;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    if (!uri) throw new Error("AUTH_TEST_MONGO_URI is required");
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(database);
    _injectTestDependencies({
      ...createAllMockDependencies(), db, authEnabled: false,
      projectStore: new ProjectStore(db.collection<ProjectDocument>("projects")),
      authProvider: null, userAccessResolver: null,
    });
  });
  afterEach(() => _injectTestDependencies({ authEnabled: false }));
  afterAll(async () => {
    _injectTestDependencies({ authEnabled: true, authProvider: null, userAccessResolver: null });
    await db?.dropDatabase();
    await client?.close();
  });

  async function create(name: string, id = randomUUID()) {
    const response = await request(app).post("/api/v1/projects").set("Idempotency-Key", id).send({ name });
    expect(response.status).toBe(201);
    return response;
  }

  it("publishes the effective mode and exposes catalogs without an identity", async () => {
    const version = await request(app).get("/api/v1/version");
    expect(version.status).toBe(200);
    expect(version.body.authEnabled).toBe(false);
    for (const path of ["/agents", "/models", "/feature-flags"]) {
      expect((await request(app).get(`/api/v1${path}`)).status).toBe(200);
    }
    expect((await request(app).get("/api/v1/projects").set("Authorization", "Bearer invalid")).status).toBe(200);
    expect(await db.collection("users").countDocuments()).toBe(0);
  });

  it("creates, lists, edits, deletes and restores without creating a user or membership", async () => {
    const key = randomUUID();
    const created = await create("Anonymous lifecycle", key);
    const id: string = created.body.id;
    expect((await create("Anonymous lifecycle", key)).body.id).toBe(id);
    const list = await request(app).get("/api/v1/projects");
    expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    const edited = await request(app).patch(`/api/v1/projects/${id}`).send({ name: "Renamed anonymously", revision: 1 });
    expect(edited.status).toBe(200);
    expect(edited.body.revision).toBe(2);
    expect((await request(app).delete(`/api/v1/projects/${id}`).send({ revision: 2 })).status).toBe(204);
    expect((await request(app).get(`/api/v1/projects/${id}`)).status).toBe(404);
    const deleted = await request(app).get("/api/v1/projects?includeDeleted=true");
    expect(deleted.body).toEqual(expect.arrayContaining([expect.objectContaining({ id, deletedAt: expect.any(String) })]));
    const restored = await request(app).post(`/api/v1/projects/${id}/restore`).send({ revision: 3 });
    expect(restored.status).toBe(200);
    expect(restored.body.deletedAt).toBeUndefined();
    expect(restored.body.revision).toBe(4);
    expect(await db.collection("users").countDocuments()).toBe(0);
    expect(await db.collection("project_memberships").countDocuments()).toBe(0);
    expect(await db.collection("admin_operations").findOne({ _id: key })).toMatchObject({
      actor: "anonymous", state: "completed", reason: "Anonymous project creation (authentication disabled)",
    });
  });

  it("still validates project scope, document relationships and project existence", async () => {
    const first = await create("First scope");
    const second = await create("Second scope");
    const foreignId = randomUUID();
    await db.collection("criteria").insertOne({ _id: foreignId, projectId: first.body.id });
    const list = await request(app).get(`/api/v1/criteria?projectId=${first.body.id}`);
    expect(list.status).toBe(200);
    expect((await request(app).get("/api/v1/criteria")).status).toBe(400);
    expect((await request(app).get(`/api/v1/criteria?projectId=${randomUUID()}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/criteria/${foreignId}?projectId=${second.body.id}`)).status).toBe(404);
    expect((await request(app).get("/api/v1/criteria/slug-without-project")).status).toBe(400);
  });

  it("does not permit enrollment, directory lookup, membership writes or operator recovery through HTTP", async () => {
    for (const method of ["get", "post"] as const) {
      expect((await request(app)[method]("/api/v1/users/me")).status).toBe(401);
    }
    for (const path of ["/admin/users", "/admin/users/search", "/admin/platform-admins", "/projects/fixture/members"]) {
      const response = await request(app).get(`/api/v1${path}`);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("authentication_disabled");
    }
    const write = await request(app).put("/api/v1/projects/fixture/members/fixture-user").send({ role: "admin", revision: 0 });
    expect(write.status).toBe(503);
    const promotion = await request(app).post("/api/v1/admin/users/fixture-user/promote").send({ revision: 0 });
    expect(promotion.status).toBe(503);
    expect(promotion.body.code).toBe("authentication_disabled");
    expect(await db.collection("project_memberships").countDocuments()).toBe(0);
  });

  it("keeps report generation disabled and makes zero enqueue calls", async () => {
    const deps = createAllMockDependencies();
    _injectTestDependencies({ reportQueueClient: deps.reportQueueClient });
    for (const path of ["/reports", "/reports/bulk-create", "/reports/trigger", "/reports/bulk-trigger", "/reports/fixture/insights"]) {
      const response = await request(app).post(`/api/v1${path}`).send({});
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("report_generation_disabled");
    }
    expect(deps.reportQueueClient?.sendMessage).not.toHaveBeenCalled();
  });

  it("re-enables enforcement without granting memberships or altering stored projects", async () => {
    const project = await create("Re-enable fixture");
    const before = await db.collection("projects").find({}).toArray();
    _injectTestDependencies({ authEnabled: true });
    expect((await request(app).get("/api/v1/version")).body.authEnabled).toBe(true);
    expect((await request(app).get("/api/v1/projects")).status).toBe(401);
    expect((await request(app).get(`/api/v1/projects/${project.body.id}`)).status).toBe(401);
    expect(await db.collection("projects").find({}).toArray()).toEqual(before);
    expect(await db.collection("project_memberships").countDocuments()).toBe(0);
  });
});
