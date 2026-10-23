// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, ProjectStore, mintRunToken, type AuthProvider, type ProjectDocument } from "shared";
import { app, _injectTestDependencies } from "../index.js";
import { createAllMockDependencies } from "../test-helpers.js";

// Service keys are read once when the API module loads, so set them first.
const keys = vi.hoisted(() => {
  const value = {
    scanner: "model-scanner-integration-key-0123456789abcdef",
    register: "register-agents-integration-key-0123456789abcdef",
  };
  process.env.INTERNAL_API_KEY_MODEL_SCANNER = value.scanner;
  process.env.INTERNAL_API_KEY_REGISTER_AGENTS = value.register;
  return value;
});

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

// IdP bearers are never accepted here: these suites exercise only run and service callers.
const rejectingProvider: AuthProvider = {
  id: "integration-fixture",
  verifyAccessToken: async () => { throw new AuthError("invalid_token", "Fixture provider accepts no IdP tokens"); },
};

const uri = process.env.AUTH_TEST_MONGO_URI;
describe.runIf(Boolean(uri))("Run-token and service-key authorization with auth enabled (native Mongo)", () => {
  const database = `caller-authz-test-${randomUUID()}`;
  let client: MongoClient;
  let db: Db;
  let projectX: string;
  let projectY: string;
  let profileX: string;

  beforeAll(async () => {
    if (!uri) throw new Error("AUTH_TEST_MONGO_URI is required");
    client = await new MongoClient(uri).connect();
    db = client.db(database);
    _injectTestDependencies({
      ...createAllMockDependencies(), db, authEnabled: true,
      projectStore: new ProjectStore(db.collection<ProjectDocument>("projects")),
      collection: db.collection("requests"),
      criteriaCollection: db.collection("criteria"),
      profileCollection: db.collection("profiles"),
      agentCollection: db.collection("agents"),
      modelCollection: db.collection("models"),
      authProvider: rejectingProvider,
      userAccessResolver: null,
    });
  });
  afterAll(async () => {
    _injectTestDependencies({ authEnabled: true, authProvider: null, userAccessResolver: null });
    await db?.dropDatabase();
    await client?.close();
  });
  beforeEach(async () => {
    projectX = randomUUID();
    projectY = randomUUID();
    profileX = randomUUID();
    const now = new Date();
    await db.collection<{ _id: string }>("projects").insertMany([
      { _id: projectX, name: "Run project", createdAt: now, updatedAt: now },
      { _id: projectY, name: "Other project", createdAt: now, updatedAt: now },
    ]);
    await db.collection<{ _id: string }>("criteria").insertMany([
      { _id: randomUUID(), id: "builds", projectId: projectX, prompt: "Builds", dependsOn: [], createdAt: now, updatedAt: now },
      { _id: randomUUID(), id: "builds", projectId: projectY, prompt: "Builds", dependsOn: [], createdAt: now, updatedAt: now },
    ]);
    await db.collection<{ _id: string }>("profiles").insertOne({ _id: profileX, projectId: projectX, name: "Profile" });
  });

  /** Insert a claimed run in `projectId` and return its bearer token. */
  async function claimedRun(projectId: string, run: Record<string, unknown> = {}): Promise<string> {
    const requestId = randomUUID();
    const { token, hash } = mintRunToken(requestId);
    await db.collection<{ _id: string }>("requests").insertOne({
      _id: requestId, projectId,
      run: { _id: randomUUID(), status: "processing", startedAt: new Date(), tokenHash: hash, ...run },
    });
    return `Bearer ${token}`;
  }

  it("accepts a run token on flagged GET routes in its own project", async () => {
    const bearer = await claimedRun(projectX);
    const list = await request(app).get(`/api/v1/criteria?projectId=${projectX}`).set("Authorization", bearer);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ id: "builds", projectId: projectX })]);
    const point = await request(app).get(`/api/v1/criteria/builds?projectId=${projectX}`).set("Authorization", bearer);
    expect(point.status).toBe(200);
  });

  it("rejects the same token on another project's route (404)", async () => {
    const bearer = await claimedRun(projectX);
    for (const path of [`/api/v1/criteria?projectId=${projectY}`, `/api/v1/criteria/builds?projectId=${projectY}`]) {
      const response = await request(app).get(path).set("Authorization", bearer);
      expect(response.status).toBe(404);
    }
  });

  it("rejects the token on non-flagged routes and on writes (403)", async () => {
    const bearer = await claimedRun(projectX);
    const cases = [
      request(app).get(`/api/v1/profiles?projectId=${projectX}`),
      request(app).get(`/api/v1/profiles/${profileX}`),
      request(app).get("/api/v1/agents"),
      request(app).get("/api/v1/projects"),
      request(app).get("/api/v1/admin/users"),
      request(app).post(`/api/v1/criteria?projectId=${projectX}`).send({ id: "new", prompt: "New" }),
    ];
    for (const pending of cases) {
      const response = await pending.set("Authorization", bearer);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("run_token_not_allowed");
    }
    expect(await db.collection("criteria").countDocuments({ id: "new" })).toBe(0);
  });

  it("returns 401 for an expired claim, a finished run and a forged token", async () => {
    const expired = await claimedRun(projectX, { startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    const expiredResponse = await request(app).get(`/api/v1/criteria?projectId=${projectX}`).set("Authorization", expired);
    expect(expiredResponse.status).toBe(401);
    expect(expiredResponse.body.code).toBe("run_token_expired");

    const finished = await claimedRun(projectX, { status: "done" });
    expect((await request(app).get(`/api/v1/criteria?projectId=${projectX}`).set("Authorization", finished)).status).toBe(401);

    const forged = `Bearer ${mintRunToken(randomUUID()).token}`;
    expect((await request(app).get(`/api/v1/criteria?projectId=${projectX}`).set("Authorization", forged)).status).toBe(401);
  });

  it("lets a service key call routes within its scopes", async () => {
    const scanner = { "X-Service-Name": "model-scanner", "X-Internal-Key": keys.scanner };
    expect((await request(app).get("/api/v1/agents").set(scanner)).status).toBe(200);
    const sync = await request(app).post("/api/v1/models/sync").set(scanner)
      .send({ agentId: "fixture-agent", provider: "fixture", models: [], scannedAt: new Date().toISOString() });
    expect(sync.status).toBe(200);
  });

  it("returns 403 when a service key calls a route outside its scopes", async () => {
    const scanner = { "X-Service-Name": "model-scanner", "X-Internal-Key": keys.scanner };
    const register = { "X-Service-Name": "register-agents", "X-Internal-Key": keys.register };
    const cases = [
      request(app).get("/api/v1/projects").set(scanner),
      request(app).get(`/api/v1/criteria?projectId=${projectX}`).set(scanner),
      request(app).get("/api/v1/admin/users").set(scanner),
      request(app).get("/api/v1/agents").set(register),
      request(app).post("/api/v1/models/sync").set(register).send({}),
    ];
    for (const pending of cases) {
      const response = await pending;
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("insufficient_scope");
    }
  });

  it("still requires authentication for callers without credentials", async () => {
    expect((await request(app).get(`/api/v1/criteria?projectId=${projectX}`)).status).toBe(401);
    expect((await request(app).get("/api/v1/agents").set({ "X-Service-Name": "model-scanner", "X-Internal-Key": "wrong-key" })).status).toBe(401);
  });
});
