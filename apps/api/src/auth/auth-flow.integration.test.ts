// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MongoClient, type Collection } from "mongodb";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EntraIdAuthProvider, type UserDocument } from "shared";
import { app, _injectTestDependencies } from "../index.js";
import { createAllMockDependencies } from "../test-helpers.js";
import { UserStore } from "./user-store.js";
import { RedisUserAccessCache } from "./user-access-cache.js";
import { UserAccessResolver } from "./user-access-resolver.js";

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
    users = mongo.db(database).collection<UserDocument>("users");
    await users.createIndex({ idp: 1, idpTenant: 1, idpSubject: 1 }, { unique: true, name: "uniq_identity" });
    inspector = new Redis({ host: "127.0.0.1", port: redisPort, maxRetriesPerRequest: 1 });
    await inspector.ping();
    cache = new RedisUserAccessCache({
      redisHost: "127.0.0.1", redisPort, redisPassword: "",
    }, { ttlSeconds: 60, namespace: database });
    store = new UserStore(users, {
      bootstrapAdmins: new Set([`entra:${tenant}/${subject}`]),
      bootstrapTenants: new Set([tenant]),
    });
    resolver = new UserAccessResolver({ userStore: store, cache, enricher: null });
    _injectTestDependencies(createAllMockDependencies());
    _injectTestDependencies({
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

  it("enrolls only on login, caches role, and performs read-only lookup after expiry", async () => {
    const bearer = `Bearer ${token()}`;
    const notEnrolled = await request(app).get("/api/v1/feature-flags").set("Authorization", bearer);
    expect(notEnrolled.status).toBe(403);
    expect(notEnrolled.body.code).toBe("user_not_enrolled");
    expect(await users.countDocuments()).toBe(0);

    const login = await request(app).post("/api/v1/users/me").set("Authorization", bearer);
    expect(login.status).toBe(200);
    expect(login.body.role).toBe("admin");
    expect(login.body.id).not.toBe(subject);
    const stored = await users.findOne({ idpSubject: subject });
    if (!stored) throw new Error("Login did not persist the user");
    expect(login.body.id).toBe(stored._id);
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
});
