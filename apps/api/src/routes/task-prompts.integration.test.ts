// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { MongoClient, type Db } from "mongodb";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskPromptStore, type UserDocument } from "shared";
import { Authorization } from "../auth/authorization.js";
import { AccessError, AdminOperations } from "../auth/admin-operations.js";
import type { RouteContext } from "../route-context.js";
import { registerTaskPromptsRoutes } from "./task-prompts.js";
import { registerPromptFeaturesRoutes } from "./prompt-features.js";

const llm = vi.hoisted(() => ({
  generateTaskPrompt: vi.fn(),
  extractPromptFeatures: vi.fn(),
  generatePromptFeaturePrompt: vi.fn(),
}));
vi.mock("../task-prompt-llm.js", () => ({ isTaskPromptLlmAvailable: () => true, generateTaskPrompt: llm.generateTaskPrompt }));
vi.mock("../prompt-feature-llm.js", () => ({
  isLlmAvailable: () => true,
  extractPromptFeatures: llm.extractPromptFeatures,
  generatePromptFeaturePrompt: llm.generatePromptFeaturePrompt,
}));

/** Regression: AI endpoints must never feed another project's data into LLM input or persisted output. */
const uri = process.env.AUTH_TEST_MONGO_URI;
describe.runIf(Boolean(uri))("AI task-prompt endpoints are project-isolated", () => {
  const database = `ai-isolation-test-${randomUUID()}`;
  const app = express();
  let client: MongoClient;
  let db: Db;
  let operations: AdminOperations;
  let projectA: string, projectB: string, memberId: string, platformId: string;
  let promptA: string, promptB: string;

  beforeAll(async () => {
    if (!uri) throw new Error("AUTH_TEST_MONGO_URI is required");
    client = await new MongoClient(uri).connect();
    db = client.db(database);
    operations = new AdminOperations(db);
    const authority = new Authorization(db);
    app.use(express.json());
    app.use((req, _res, next) => {
      // Harness starts AFTER bearer verification; canonical membership authority is real.
      req.user = { id: memberId, role: "user", isAuthenticated: true };
      req.auth = { token: `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url")}.s` };
      next();
    });
    app.locals.authorization = () => authority;
    const taskPromptCollection = db.collection("task-prompts");
    const ctx = {
      app, registry: new OpenAPIRegistry(), db,
      taskPromptCollection, promptFeatureCollection: db.collection("prompt-features"),
      taskPromptStore: new TaskPromptStore(taskPromptCollection as never),
    } as unknown as RouteContext;
    registerTaskPromptsRoutes(ctx);
    registerPromptFeaturesRoutes(ctx);
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error instanceof AccessError ? error.status : 500).json({ error: error.message });
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    llm.generateTaskPrompt.mockResolvedValue({ tasks: ["generated"] });
    llm.generatePromptFeaturePrompt.mockResolvedValue({ prompt: "generated" });
    llm.extractPromptFeatures.mockImplementation(async (_text: string, configs: { id: string }[]) => ({
      results: configs.map(c => ({ featureId: c.id, detected: true, evaluated: true })), suggestedFeatures: [],
    }));
    projectA = randomUUID(); projectB = randomUUID(); memberId = randomUUID(); platformId = randomUUID();
    promptA = randomUUID(); promptB = randomUUID();
    const now = new Date();
    await db.collection<UserDocument>("users").insertMany([
      { _id: memberId, idp: "entra", idpTenant: "fixture", idpSubject: memberId, role: "user", createdAt: now, updatedAt: now },
      { _id: platformId, idp: "entra", idpTenant: "fixture", idpSubject: platformId, role: "admin", createdAt: now, updatedAt: now },
    ]);
    await db.collection("projects").insertMany([{ _id: projectA, name: "A" }, { _id: projectB, name: "B" }] as never);
    await db.collection("task-prompts").insertMany([
      { _id: promptA, projectId: projectA, keyId: "a", type: "select", text: "A secret prompt", createdAt: now },
      { _id: promptB, projectId: projectB, keyId: "b", type: "select", text: "B secret prompt", createdAt: now },
    ] as never);
    await db.collection("prompt-features").insertMany([
      { id: "feature_a", projectId: projectA, prompt: "A feature?", createdAt: now },
      { id: "feature_b", projectId: projectB, prompt: "B feature?", createdAt: now },
    ] as never);
    // Member of project A only.
    await operations.execute({
      _id: randomUUID(), actor: platformId, reason: "Isolation fixture",
      collection: "project_memberships", targetId: `${projectA}:${memberId}`, expectedRevision: 0,
      change: { role: "contributor" }, unset: ["revokedAt"], initial: { projectId: projectA, userId: memberId, createdByUserId: platformId },
    });
  });
  afterAll(async () => { if (db) await db.dropDatabase(); await client?.close(); });

  it("generate sends only the authorized project's prompts to the LLM", async () => {
    const res = await request(app).post(`/api/v1/task-prompts/generate?projectId=${projectA}`).send({ description: "x" });
    expect(res.status).toBe(200);
    const existing: string[] = llm.generateTaskPrompt.mock.calls[0][1];
    expect(existing).toContain("A secret prompt");
    expect(existing).not.toContain("B secret prompt");
  });

  it("extract-features sends and persists only the prompt's project features", async () => {
    const res = await request(app).post(`/api/v1/task-prompts/${promptA}/extract-features?force=true`).send({});
    expect(res.status).toBe(200);
    const configs: { id: string }[] = llm.extractPromptFeatures.mock.calls[0][1];
    expect(configs.map(c => c.id)).toEqual(["feature_a"]);
    const stored = await db.collection("task-prompts").findOne({ _id: promptA as never });
    expect(stored?.features.map((f: { featureId: string }) => f.featureId)).toEqual(["feature_a"]);
  });

  it("prompt-feature generate/extract endpoints only read the authorized project's features", async () => {
    expect((await request(app).post(`/api/v1/prompt-features/generate-prompt?projectId=${projectA}`).send({ behavior: "b" })).status).toBe(200);
    expect(llm.generatePromptFeaturePrompt.mock.calls[0][1].map((f: { id: string }) => f.id)).toEqual(["feature_a"]);
    expect((await request(app).post(`/api/v1/prompt-features/extract-from-text?projectId=${projectA}`).send({ text: "t" })).status).toBe(200);
    expect(llm.extractPromptFeatures.mock.calls[0][1].map((f: { id: string }) => f.id)).toEqual(["feature_a"]);
  });

  it("denies the foreign project and requires a project on generate", async () => {
    expect((await request(app).post(`/api/v1/task-prompts/generate?projectId=${projectB}`).send({ description: "x" })).status).toBe(404);
    expect((await request(app).post(`/api/v1/task-prompts/${promptB}/extract-features?force=true`).send({})).status).toBe(404);
    expect((await request(app).post("/api/v1/task-prompts/generate").send({ description: "x" })).status).toBe(400);
    expect(llm.generateTaskPrompt).not.toHaveBeenCalled();
    expect(llm.extractPromptFeatures).not.toHaveBeenCalled();
  });
});
