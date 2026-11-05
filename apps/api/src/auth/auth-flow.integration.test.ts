// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MongoClient, type Collection, type Db } from "mongodb";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EntraIdAuthProvider, ProjectStore, type ProjectDocument, type UserDocument } from "shared";
import { AccessCapabilitiesSchema, PlatformAdminListSchema, type AccessUserSearchResult, type ProjectMembershipSummary } from "shared/rbac";
import { app, _injectTestDependencies } from "../index.js";
import { createAllMockDependencies } from "../test-helpers.js";
import { UserStore } from "./user-store.js";
import { RedisUserAccessCache } from "./user-access-cache.js";
import { UserAccessResolver } from "./user-access-resolver.js";
import { AdminOperations, type AdminOperation } from "./admin-operations.js";
import { operatorAccess } from "./operator-access.js";

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

// Opt into isolated infrastructure; never use or clear the application's database.
const mongoUri = process.env.AUTH_TEST_MONGO_URI;
const redisPort = Number(process.env.AUTH_TEST_REDIS_PORT);
const tenant = "11111111-1111-1111-1111-111111111111";
const subject = "aaaaaaaa-0000-0000-0000-000000000001";

describe.runIf(Boolean(mongoUri && redisPort))("IdP -> explicit login -> Redis/Mongo access", () => {
  const database = `auth-test-${randomUUID()}`;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let mongo: MongoClient;
  let db: Db;
  let users: Collection<UserDocument>;
  let inspector: Redis;
  let cache: RedisUserAccessCache;
  let store: UserStore;
  let resolver: UserAccessResolver;

  function token(oid = subject, expired = false): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
      aud: "scope-api",
      tid: tenant,
      oid,
      exp: expired ? now - 10 : now + 300,
      name: "Integration User",
      email: "integration@example.test",
      email_verified: true,
    })).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  }

  beforeAll(async () => {
    if (!mongoUri) throw new Error("AUTH_TEST_MONGO_URI is required");
    mongo = new MongoClient(mongoUri);
    await mongo.connect();
    db = mongo.db(database);
    users = db.collection<UserDocument>("users");
    await users.createIndex({ idp: 1, idpTenant: 1, idpSubject: 1 }, { unique: true, name: "uniq_identity" });
    inspector = new Redis({ host: "127.0.0.1", port: redisPort, maxRetriesPerRequest: 1 });
    await inspector.ping();
    cache = new RedisUserAccessCache({
      redisHost: "127.0.0.1", redisPort, redisPassword: "",
    }, { ttlSeconds: 60, namespace: database });
    store = new UserStore(users);
    resolver = new UserAccessResolver({ userStore: store, cache, enricher: null });
    _injectTestDependencies(createAllMockDependencies());
    _injectTestDependencies({
      db,
      usersCollection: users,
      authProvider: new EntraIdAuthProvider({
        authority: "https://login.microsoftonline.com/common",
        audience: "scope-api",
        jwks: {
          resolve: async () => keys.publicKey,
          getCurrentJwks: () => ({
            keys: [{
              kty: "RSA",
              issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
            }],
          }),
        },
      }),
      userAccessResolver: resolver,
    });
  });

  afterAll(async () => {
    _injectTestDependencies({ authProvider: null, userAccessResolver: null });
    await cache?.close();
    if (inspector) {
      const ownKeys = await inspector.keys(`auth-user:v1:${encodeURIComponent(database)}:*`);
      if (ownKeys.length) await inspector.del(...ownKeys);
      await inspector.quit();
    }
    if (mongo) {
      await mongo.db(database).dropDatabase();
      await mongo.close();
    }
  });
  afterEach(() => vi.restoreAllMocks());

  async function administrationFixture() {
    _injectTestDependencies({ projectStore: new ProjectStore(db.collection<ProjectDocument>("projects")) });
    const adminSubject = randomUUID(), userSubject = randomUUID();
    const adminBearer = `Bearer ${token(adminSubject)}`, userBearer = `Bearer ${token(userSubject)}`;
    const admin = await request(app).post("/api/v1/users/me").set("Authorization", adminBearer);
    const user = await request(app).post("/api/v1/users/me").set("Authorization", userBearer);
    expect(admin.status).toBe(200);
    expect(user.status).toBe(200);
    const adminId: string = admin.body.id, userId: string = user.body.id;
    await operatorAccess(db, {
      database, confirmDatabase: database, idp: "entra", tenant, subject: adminSubject,
      userId: adminId, revision: 0, role: "admin", disabled: "false", operator: "native-promotion-test",
      reason: "Isolated platform administrator fixture", operationId: randomUUID(), apply: true,
    });
    return { adminId, userId, adminBearer, userBearer };
  }

  it("enrolls only on login, caches role, and performs read-only lookup after expiry", async () => {
    const bearer = `Bearer ${token()}`;
    const notEnrolled = await request(app).get("/api/v1/feature-flags").set("Authorization", bearer);
    expect(notEnrolled.status).toBe(403);
    expect(notEnrolled.body.code).toBe("user_not_enrolled");
    expect(await users.countDocuments()).toBe(0);

    const login = await request(app).post("/api/v1/users/me").set("Authorization", bearer);
    expect(login.status).toBe(200);
    expect(login.body.role).toBe("user");
    expect(login.body.id).not.toBe(subject);
    let stored = await users.findOne({ idpSubject: subject });
    if (!stored) throw new Error("Login did not persist the user");
    expect(login.body.id).toBe(stored._id);
    await operatorAccess(db, {
      database, confirmDatabase: database, idp: "entra", tenant, subject, userId: stored._id,
      role: "admin", disabled: "false", revision: 0, operationId: randomUUID(),
      operator: "isolated-auth-test", reason: "Explicit enrolled-user bootstrap", bootstrap: true, apply: true,
    });
    const refreshed = await request(app).post("/api/v1/users/me").set("Authorization", bearer);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.role).toBe("admin");
    stored = await users.findOne({ idpSubject: subject });
    if (!stored) throw new Error("Bootstrapped user disappeared");
    const lastLogin = stored.lastLoginAt?.getTime();
    expect(lastLogin).toBeTypeOf("number");

    const ownKeys = await inspector.keys(`auth-user:v1:${encodeURIComponent(database)}:*`);
    expect(ownKeys).toHaveLength(1);
    expect(ownKeys[0]).toContain(`:entra:${tenant}:${subject}`);
    expect(await inspector.ttl(ownKeys[0])).toBeGreaterThan(0);
    const lookup = vi.spyOn(store, "findByIdentity");
    const upsert = vi.spyOn(store, "upsertOnLogin");
    const read = vi.spyOn(cache, "get");
    const warm = vi.spyOn(cache, "set");

    const me = await request(app).get("/api/v1/users/me").set("Authorization", bearer);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(stored._id);
    expect(lookup).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();

    read.mockClear();
    const expired = await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${token(subject, true)}`);
    expect(expired.status).toBe(401);
    expect(read).not.toHaveBeenCalled();

    await users.updateOne({ idpSubject: subject }, { $set: { role: "user" } });
    await inspector.pexpire(ownKeys[0], 100);
    const beforeExpiry = await request(app).get("/api/v1/users/me").set("Authorization", bearer);
    expect(beforeExpiry.body.role).toBe("admin");
    expect(await inspector.pttl(ownKeys[0])).toBeLessThanOrEqual(100);
    await delay(120);
    const afterExpiry = await request(app).get("/api/v1/users/me").set("Authorization", bearer);
    expect(afterExpiry.body.role).toBe("user");
    expect(lookup).toHaveBeenCalledOnce();
    expect(warm).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    expect((await users.findOne({ idpSubject: subject }))?.lastLoginAt?.getTime()).toBe(lastLogin);

    await users.updateOne({ idpSubject: subject }, { $set: { disabledAt: new Date() } });
    await inspector.del(ownKeys[0]);
    const disabled = await request(app).get("/api/v1/users/me").set("Authorization", bearer);
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe("user_disabled");
    expect(await inspector.exists(ownKeys[0])).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("allows global admin catalogs without membership and retains member selection without administration", async () => {
    const { adminId, userId, adminBearer, userBearer } = await administrationFixture();
    expect(await db.collection("project_memberships").countDocuments({ userId: adminId })).toBe(0);
    for (const path of ["/api/v1/agents", "/api/v1/models"]) {
      expect((await request(app).get(path).set("Authorization", adminBearer)).status).toBe(200);
      expect((await request(app).get(path).set("Authorization", userBearer)).status).toBe(403);
      expect((await request(app).get(path)).status).toBe(401);
    }
    const project = await request(app).post("/api/v1/projects")
      .set("Authorization", adminBearer).send({ name: "Catalog selection fixture" });
    expect(project.status).toBe(201);
    const projectId: string = project.body.id;
    let revision = 0;
    for (const role of ["reader", "contributor", "admin"]) {
      const grant = await request(app).put(`/api/v1/projects/${projectId}/members/${userId}`)
        .set("Authorization", adminBearer).send({ role, revision });
      expect(grant.status).toBe(200);
      revision++;
      for (const path of ["/api/v1/agents", "/api/v1/models"]) {
        expect((await request(app).get(path).set("Authorization", userBearer)).status).toBe(200);
      }
      for (const path of ["/api/v1/agents", "/api/v1/models/sync", "/api/v1/keys", "/api/v1/accounts"]) {
        expect((await request(app).post(path).set("Authorization", userBearer).send({})).status).toBe(403);
      }
    }
    const revoke = await request(app).delete(`/api/v1/projects/${projectId}/members/${userId}`)
      .set("Authorization", adminBearer).send({ revision });
    expect(revoke.status).toBe(200);
    for (const path of ["/api/v1/agents", "/api/v1/models"]) {
      expect((await request(app).get(path).set("Authorization", userBearer)).status).toBe(403);
    }
  });

  describe("Platform administrator HTTP operations", () => {
    it("lists only platform administrators with server-side pagination and no identity secrets", async () => {
      const { adminBearer, userBearer, userId } = await administrationFixture();
      const disabledAdmin = await store.upsertOnLogin({ idp: "entra", idpTenant: tenant, idpSubject: randomUUID() }, { displayName: "Disabled administrator fixture" });
      await new AdminOperations(db).execute({
        _id: randomUUID(), actor: "test-operator", reason: "Disabled administrator roster fixture",
        collection: "users", targetId: disabledAdmin._id, expectedRevision: 0,
        change: { role: "admin", disabledAt: "$operationTime" }, unset: [],
      });
      expect((await request(app).get("/api/v1/admin/platform-admins")).status).toBe(401);
      expect((await request(app).get("/api/v1/admin/platform-admins").set("Authorization", "Bearer invalid")).status).toBe(401);
      expect((await request(app).get("/api/v1/admin/platform-admins").set("Authorization", userBearer)).status).toBe(403);
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const response = await request(app).get("/api/v1/admin/platform-admins")
          .query({ limit: 1, ...(cursor ? { cursor } : {}) }).set("Authorization", adminBearer);
        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        const page = PlatformAdminListSchema.parse(response.body);
        expect(page.items.length).toBeLessThanOrEqual(1);
        for (const admin of page.items) {
          expect(admin.role).toBe("admin");
          for (const key of Object.keys(admin)) {
            expect(["id", "displayName", "email", "alias", "role", "disabled", "revision", "pending", "operationId"]).toContain(key);
          }
          if (admin.id === disabledAdmin._id) expect(admin).toMatchObject({ disabled: true, pending: false });
          ids.push(admin.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
      expect(ids).toEqual((await users.find({ role: "admin" }).sort({ _id: 1 }).toArray()).map(user => user._id));
      expect(ids).not.toContain(userId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const query of [{ limit: 0 }, { limit: 51 }, { cursor: "" }, { role: "user" }]) {
        expect((await request(app).get("/api/v1/admin/platform-admins").query(query).set("Authorization", adminBearer)).status).toBe(400);
      }
    });

    it("promotes exactly once through HTTP, refreshes canonical capabilities and grants no project membership", async () => {
      const { adminId, adminBearer, userId, userBearer } = await administrationFixture();
      const path = `/api/v1/admin/users/${userId}/promote`;
      const id = randomUUID();
      expect((await request(app).post(path).send({ revision: 0 })).status).toBe(401);
      expect((await request(app).post(path).set("Authorization", userBearer).send({ revision: 0 })).status).toBe(403);
      const promote = () => request(app).post(path).set("Authorization", adminBearer).set("Idempotency-Key", id).send({ revision: 0 });
      const result = await promote();
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ state: "completed", operationId: id, revision: 1 });
      expect((await promote()).body).toEqual(result.body);
      expect(await users.findOne({ _id: userId })).toMatchObject({
        role: "admin", revision: 1, lastOperationId: id, appliedOperationIds: [id],
      });
      expect(await db.collection<AdminOperation>("admin_operations").findOne({ _id: id })).toMatchObject({
        actor: adminId, targetId: userId, state: "completed", expectedRevision: 0,
        collection: "users", change: { role: "admin" }, condition: { role: "user", disabledAt: { $exists: false } },
      });
      const me = await request(app).get("/api/v1/users/me").set("Authorization", userBearer);
      expect(me.status).toBe(200);
      expect(me.body.capabilities).toMatchObject({ platformAdmin: true, memberships: [] });
      expect(await db.collection("project_memberships").countDocuments({ userId })).toBe(0);
      expect((await request(app).get("/api/v1/agents").set("Authorization", userBearer)).status).toBe(200);
      expect((await request(app).get("/api/v1/models").set("Authorization", userBearer)).status).toBe(200);
      const project = await request(app).post("/api/v1/projects")
        .set("Authorization", adminBearer).send({ name: "No catalog content bypass" });
      expect(project.status).toBe(201);
      expect((await request(app).get("/api/v1/requests").query({ projectId: project.body.id })
        .set("Authorization", userBearer)).status).toBe(404);
      expect((await request(app).post(`/api/v1/admin/users/${userId}/disable`).set("Authorization", adminBearer).send({ revision: 1 })).status).toBe(403);
      const reused = await request(app).post(path).set("Authorization", adminBearer).set("Idempotency-Key", id).send({ revision: 1 });
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe("idempotency_conflict");

      await new AdminOperations(db).execute({
        _id: randomUUID(), actor: "test-operator", reason: "Later demotion fixture",
        collection: "users", targetId: userId, expectedRevision: 1, change: { role: "user" }, unset: [],
      });
      expect((await promote()).body).toEqual(result.body);
      expect(await users.findOne({ _id: userId })).toMatchObject({ role: "user", revision: 2 });
    });

    it("rejects disabled, missing, already-admin, stale and arbitrary-role targets without elevating them", async () => {
      const { adminId, adminBearer, userId } = await administrationFixture();
      const promote = (id: string, body: unknown) => request(app).post(`/api/v1/admin/users/${id}/promote`)
        .set("Authorization", adminBearer).send(body);
      for (const body of [{}, { revision: -1 }, { revision: 1.5 }, { revision: "0" }, { revision: 0, role: "user" }, { revision: 0, disabled: false }]) {
        expect((await promote(userId, body)).status).toBe(400);
      }
      expect((await promote(randomUUID(), { revision: 0 })).status).toBe(404);
      expect((await promote(adminId, { revision: 1 })).status).toBe(409);
      expect((await promote(userId, { revision: 4 })).status).toBe(409);
      await users.updateOne({ _id: userId }, { $set: { disabledAt: new Date() } });
      expect((await promote(userId, { revision: 0 })).status).toBe(409);
      expect(await users.findOne({ _id: userId })).toMatchObject({ role: "user", disabledAt: expect.any(Date) });
    });

    it("does not let a project admin elevate platform roles and only accepts one competing promotion", async () => {
      const { adminBearer, userId, userBearer } = await administrationFixture();
      const created = await request(app).post("/api/v1/projects").set("Authorization", adminBearer).send({ name: "Promotion boundary" });
      expect(created.status).toBe(201);
      const projectId: string = created.body.id;
      expect((await request(app).put(`/api/v1/projects/${projectId}/members/${userId}`)
        .set("Authorization", adminBearer).send({ role: "admin", revision: 0 })).status).toBe(200);
      const path = `/api/v1/admin/users/${userId}/promote`;
      expect((await request(app).post(path).set("Authorization", userBearer).send({ revision: 0 })).status).toBe(403);
      expect((await request(app).get("/api/v1/admin/platform-admins").set("Authorization", userBearer)).status).toBe(403);
      const results = await Promise.all([randomUUID(), randomUUID()].map(id =>
        request(app).post(path).set("Authorization", adminBearer).set("Idempotency-Key", id).send({ revision: 0 })));
      expect(results.map(result => result.status).sort()).toEqual([200, 409]);
      expect(await users.findOne({ _id: userId })).toMatchObject({ role: "admin", revision: 1 });
    });

    it("withholds a partially completed promotion and recovers with the identical HTTP operation", async () => {
      const { adminBearer, userId, userBearer } = await administrationFixture();
      const id = randomUUID();
      const operations = db.collection<AdminOperation>("admin_operations");
      const originalCollection = db.collection.bind(db);
      vi.spyOn(db, "collection").mockImplementation(name => name === "admin_operations" ? operations : originalCollection(name));
      const update = operations.updateOne.bind(operations);
      const completion = vi.spyOn(operations, "updateOne").mockImplementation(async (...args) => {
        if (args[0]._id === id) throw new Error("Promotion completion store unavailable");
        return update(...args);
      });
      const promote = () => request(app).post(`/api/v1/admin/users/${userId}/promote`)
        .set("Authorization", adminBearer).set("Idempotency-Key", id).send({ revision: 0 });
      expect((await promote()).status).toBe(202);
      expect(await users.findOne({ _id: userId })).toMatchObject({ role: "admin", revision: 1, lastOperationId: id });
      const pendingUser = await request(app).get("/api/v1/users/me").set("Authorization", userBearer);
      expect(pendingUser.status).toBe(503);
      expect(pendingUser.body.code).toBe("operation_pending");
      const roster = await request(app).get("/api/v1/admin/platform-admins").set("Authorization", adminBearer);
      expect(PlatformAdminListSchema.parse(roster.body).items.find(user => user.id === userId)).toMatchObject({ pending: true, operationId: id });
      completion.mockRestore();
      const recovered = await promote();
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual({ operationId: id, state: "completed", revision: 1 });
      expect(await users.findOne({ _id: userId })).toMatchObject({ revision: 1, appliedOperationIds: [id] });
      expect((await request(app).get("/api/v1/users/me").set("Authorization", userBearer)).body.capabilities.platformAdmin).toBe(true);
    });

    it("does not mutate on intent failure or overwrite another pending user-security operation", async () => {
      const { adminBearer, userId } = await administrationFixture();
      const operations = db.collection<AdminOperation>("admin_operations");
      const originalCollection = db.collection.bind(db);
      vi.spyOn(db, "collection").mockImplementation(name => name === "admin_operations" ? operations : originalCollection(name));
      vi.spyOn(operations, "insertOne").mockRejectedValueOnce(new Error("Intent store unavailable"));
      const path = `/api/v1/admin/users/${userId}/promote`;
      expect((await request(app).post(path).set("Authorization", adminBearer).send({ revision: 0 })).status).toBe(503);
      expect(await users.findOne({ _id: userId })).toMatchObject({ role: "user" });
      const pendingId = randomUUID();
      await users.updateOne({ _id: userId }, { $set: { revision: 1, lastOperationId: pendingId } });
      const blocked = await request(app).post(path).set("Authorization", adminBearer).send({ revision: 1 });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("operation_pending");
      expect(await users.findOne({ _id: userId })).toMatchObject({ role: "user", revision: 1, lastOperationId: pendingId });
    });

    it("rechecks the enabled-state precondition at the final promotion write", async () => {
      const { adminBearer, userId } = await administrationFixture();
      const execute = AdminOperations.prototype.execute;
      vi.spyOn(AdminOperations.prototype, "execute").mockImplementation(async function (this: AdminOperations, intent) {
        await users.updateOne({ _id: userId }, { $set: { disabledAt: new Date() } });
        return execute.call(this, intent);
      });
      const result = await request(app).post(`/api/v1/admin/users/${userId}/promote`)
        .set("Authorization", adminBearer).send({ revision: 0 });
      expect(result.status).toBe(409);
      expect(await users.findOne({ _id: userId })).toMatchObject({ role: "user", disabledAt: expect.any(Date) });
    });
  });

  it("uses MongoDB and admits no missing users when the cache is unavailable", async () => {
    const otherSubject = randomUUID();
    const bearer = `Bearer ${token(otherSubject)}`;
    const login = await request(app).post("/api/v1/users/me").set("Authorization", bearer);
    expect(login.status).toBe(200);
    await cache.close();
    const before = await users.findOne({ idpSubject: otherSubject });
    const res = await request(app).get("/api/v1/users/me").set("Authorization", bearer);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("user");
    const missing = await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${token("missing-user")}`);
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe("user_not_enrolled");
    expect((await users.findOne({ idpSubject: otherSubject }))?.lastLoginAt).toEqual(before?.lastLoginAt);
    expect(await users.countDocuments({ idpSubject: otherSubject })).toBe(1);
  });

  it("keeps global search platform-only while verified project admins search enrolled membership candidates", async () => {
    const db = mongo.db(database);
    _injectTestDependencies({ projectStore: new ProjectStore(db.collection<ProjectDocument>("projects")) });
    const adminSubject = randomUUID(), ordinarySubject = randomUUID();
    const adminBearer = `Bearer ${token(adminSubject)}`, ordinaryBearer = `Bearer ${token(ordinarySubject)}`;
    const enrolled = await request(app).post("/api/v1/users/me").set("Authorization", adminBearer);
    expect(enrolled.status).toBe(200);
    const adminId: string = enrolled.body.id;
    await operatorAccess(db, {
      database, confirmDatabase: database, idp: "entra", tenant, subject: adminSubject,
      userId: adminId, revision: 0, role: "admin", disabled: "false", operator: "native-access-test",
      reason: "Isolated administrative directory fixture", operationId: randomUUID(), apply: true,
    });
    const ordinary = await request(app).post("/api/v1/users/me").set("Authorization", ordinaryBearer);
    expect(ordinary.status).toBe(200);
    const ordinaryId: string = ordinary.body.id;
    const prefix = `Directory fixture ${randomUUID()}`;
    const fixtures = await Promise.all(["Alice", "Bob.*[", "Charlie"].map(name => store.upsertOnLogin({
      idp: "entra", idpTenant: tenant, idpSubject: randomUUID(),
    }, { displayName: `${prefix} ${name}`, email: `${name}@example.test`, emailVerified: true })));

    expect((await request(app).get("/api/v1/admin/users/search")).status).toBe(401);
    expect((await request(app).get("/api/v1/admin/users/search").set("Authorization", ordinaryBearer)).status).toBe(403);
    const first = await request(app).get("/api/v1/admin/users/search").query({ q: prefix.toUpperCase(), limit: 2 }).set("Authorization", adminBearer);
    expect(first.status).toBe(200);
    const firstPage: AccessUserSearchResult = first.body;
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBeTruthy();
    const second = await request(app).get("/api/v1/admin/users/search")
      .query({ q: prefix, limit: 2, cursor: firstPage.nextCursor }).set("Authorization", adminBearer);
    expect(second.status).toBe(200);
    const secondPage: AccessUserSearchResult = second.body;
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(new Set([...firstPage.items, ...secondPage.items].map(user => user.id))).toEqual(new Set(fixtures.map(user => user._id)));
    for (const user of firstPage.items) {
      expect(Object.keys(user).sort()).toEqual(["alias", "disabled", "displayName", "email", "id", "revision", "role"]);
    }
    const literal = await request(app).get("/api/v1/admin/users/search").query({ q: ".*[" }).set("Authorization", adminBearer);
    expect(literal.status).toBe(200);
    const matches: AccessUserSearchResult = literal.body;
    expect(matches.items.map(user => user.id)).toEqual([fixtures[1]._id]);
    for (const query of [{ limit: 0 }, { limit: 51 }, { q: "x".repeat(101) }, { cursor: "" }]) {
      expect((await request(app).get("/api/v1/admin/users/search").query(query).set("Authorization", adminBearer)).status).toBe(400);
    }
    const project = await request(app).post("/api/v1/projects").set("Authorization", adminBearer).send({ name: "Directory access fixture" });
    expect(project.status).toBe(201);
    const projectId: string = project.body.id;
    const grant = await request(app).put(`/api/v1/projects/${projectId}/members/${ordinaryId}`)
      .set("Authorization", adminBearer).send({ role: "admin", revision: 0 });
    expect(grant.status).toBe(200);
    expect((await request(app).get("/api/v1/admin/users/search").set("Authorization", ordinaryBearer)).status).toBe(403);
    expect((await request(app).get(`/api/v1/projects/${projectId}/members`).set("Authorization", ordinaryBearer)).status).toBe(200);
    const searchPath = `/api/v1/projects/${projectId}/members/search`;
    expect((await request(app).get(searchPath)).status).toBe(401);
    expect((await request(app).get(searchPath).set("Authorization", "Bearer invalid")).status).toBe(401);
    const scopedFirst = await request(app).get(searchPath)
      .query({ q: prefix.toUpperCase(), limit: 2 }).set("Authorization", ordinaryBearer);
    expect(scopedFirst.status).toBe(200);
    expect(scopedFirst.headers["cache-control"]).toBe("no-store");
    const scopedFirstPage: AccessUserSearchResult = scopedFirst.body;
    const scopedSecond = await request(app).get(searchPath)
      .query({ q: prefix, limit: 2, cursor: scopedFirstPage.nextCursor }).set("Authorization", ordinaryBearer);
    expect(scopedSecond.status).toBe(200);
    const scopedSecondPage: AccessUserSearchResult = scopedSecond.body;
    expect(new Set([...scopedFirstPage.items, ...scopedSecondPage.items].map(user => user.id)))
      .toEqual(new Set(fixtures.map(user => user._id)));
    const foreign = await request(app).post("/api/v1/projects").set("Authorization", adminBearer).send({ name: "Foreign directory fixture" });
    expect(foreign.status).toBe(201);
    expect((await request(app).get(`/api/v1/projects/${foreign.body.id}/members/search`)
      .set("Authorization", ordinaryBearer)).status).toBe(404);
    const candidate = fixtures[0];
    expect((await request(app).get(`/api/v1/projects/${projectId}/members/lookup/${candidate._id}`)
      .set("Authorization", ordinaryBearer)).status).toBe(200);
    const assignmentId = randomUUID();
    const assignment = await request(app).put(`/api/v1/projects/${projectId}/members/${candidate._id}`)
      .set("Authorization", ordinaryBearer).set("Idempotency-Key", assignmentId).send({ role: "contributor", revision: 0 });
    expect(assignment.status).toBe(200);
    expect((await request(app).get(searchPath).set("Authorization", `Bearer ${await token(candidate.idpSubject)}`)).status).toBe(403);
    expect(await db.collection<AdminOperation>("admin_operations").findOne({ _id: assignmentId })).toMatchObject({
      actor: ordinaryId, state: "completed", reason: "Explicit project-admin membership assignment",
    });
    const roster = await request(app).get(`/api/v1/projects/${projectId}/members`).set("Authorization", adminBearer);
    expect(roster.status).toBe(200);
    const members: ProjectMembershipSummary[] = roster.body;
    expect(members.find(member => member.userId === ordinaryId)).toMatchObject({
      role: "admin", revision: 1, pending: false, user: { id: ordinaryId, displayName: "Integration User", disabled: false },
    });
    const disabled = fixtures[2];
    await new AdminOperations(db).execute({
      _id: randomUUID(), actor: adminId, reason: "Disabled directory fixture",
      collection: "users", targetId: disabled._id, expectedRevision: 0,
      change: { disabledAt: "$operationTime" }, unset: [], condition: { role: "user" },
    });
    expect((await request(app).put(`/api/v1/projects/${projectId}/members/${disabled._id}`)
      .set("Authorization", adminBearer).send({ role: "reader", revision: 0 })).status).toBe(409);
    const disabledSearch = await request(app).get("/api/v1/admin/users/search")
      .query({ q: disabled._id }).set("Authorization", adminBearer);
    const disabledResult: AccessUserSearchResult = disabledSearch.body;
    expect(disabledResult.items[0]).toMatchObject({ id: disabled._id, disabled: true });
    const exact = await request(app).get("/api/v1/admin/users").query({ userId: ordinaryId }).set("Authorization", adminBearer);
    expect(exact.status).toBe(200);
    expect(exact.body[0].id).toBe(ordinaryId);
    const capabilities = async () => {
      const me = await request(app).get("/api/v1/users/me").set("Authorization", ordinaryBearer);
      expect(me.status).toBe(200);
      return AccessCapabilitiesSchema.parse(me.body.capabilities);
    };
    expect((await capabilities()).memberships.find(member => member.projectId === projectId)?.permissions).toContain("members:write");
    const selfPath = `/api/v1/projects/${projectId}/members/${ordinaryId}`;
    expect((await request(app).put(selfPath).set("Authorization", ordinaryBearer).send({ role: "reader", revision: 1 })).status).toBe(200);
    expect((await capabilities()).memberships.find(member => member.projectId === projectId)?.permissions).not.toContain("members:write");
    expect((await request(app).get(`/api/v1/projects/${projectId}/members`).set("Authorization", ordinaryBearer)).status).toBe(403);
    expect((await request(app).put(selfPath).set("Authorization", adminBearer).send({ role: "admin", revision: 2 })).status).toBe(200);
    expect((await request(app).delete(selfPath).set("Authorization", ordinaryBearer).send({ revision: 3 })).status).toBe(200);
    expect((await capabilities()).memberships.some(member => member.projectId === projectId)).toBe(false);
    expect((await request(app).get(`/api/v1/projects/${projectId}/members`).set("Authorization", ordinaryBearer)).status).toBe(404);
  });
});
