// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import request from "supertest";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { afterAll, describe, expect, it } from "vitest";
import type { RouteContext } from "./route-context.js";
import { registerCriteriaRoutes } from "./routes/criteria.js";
import { registerPromptFeaturesRoutes } from "./routes/prompt-features.js";
import { registerTaskPromptsRoutes } from "./routes/task-prompts.js";
import {
  getPortalCopilotClientPool,
  shutdownPortalCopilotClientPool,
} from "./copilot-client-pool.js";

const integrationEnabled =
  process.env.RUN_PORTAL_AI_COPILOT_INTEGRATION === "1" &&
  !!process.env.TOKEN_MANAGER_URL;
const describeIntegration = integrationEnabled ? describe : describe.skip;

function cursor<T>(rows: T[]) {
  return {
    project() {
      return this;
    },
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    async toArray() {
      return rows;
    },
  };
}

function createPortalAiApp() {
  const app = express();
  app.use(express.json());

  const criteria = [
    {
      id: "has_tests",
      prompt: "The project includes tests.",
      dependsOn: [],
      gates: ["select"],
    },
    {
      id: "tests_pass",
      prompt: "The captured test command succeeds.",
      dependsOn: ["has_tests"],
      gates: ["select", "test"],
    },
  ];
  const promptFeatures = [
    {
      id: "asks_for_tests",
      prompt: "The task asks the coding agent to add or run tests.",
      type: "select",
    },
  ];

  const ctx = {
    app,
    registry: new OpenAPIRegistry(),
    criteriaCollection: {
      find: () => cursor(criteria),
    },
    promptFeatureCollection: {
      find: () => cursor(promptFeatures),
    },
    taskPromptCollection: {
      find: () => cursor([]),
    },
  } as unknown as RouteContext;

  registerCriteriaRoutes(ctx);
  registerPromptFeaturesRoutes(ctx);
  registerTaskPromptsRoutes(ctx);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return app;
}

describeIntegration("Portal AI Copilot end-to-end smoke", () => {
  const app = createPortalAiApp();

  afterAll(async () => {
    await shutdownPortalCopilotClientPool();
  });

  it("forces Token Manager to Copilot SDK and exercises every Portal AI route", async () => {
    expect(process.env.GITHUB_TOKEN).toBeFalsy();
    expect(process.env.GITHUB_MODELS_API_KEY).toBeFalsy();
    expect(process.env.AZURE_AI_INFERENCE_ENDPOINT).toBeFalsy();
    expect(process.env.AZURE_AI_INFERENCE_API_KEY).toBeFalsy();

    const pool = getPortalCopilotClientPool();
    const before = pool.stats();

    const criterion = await request(app)
      .post("/api/v1/criteria/generate-prompt")
      .send({
        behavior: "The project includes meaningful automated tests.",
        gates: ["select"],
      })
      .expect(200);
    expect(criterion.body).toEqual({
      prompt: expect.any(String),
      suggestedId: expect.any(String),
      suggestedParents: expect.any(Array),
      suggestedChildren: expect.any(Array),
    });

    const afterCriterion = pool.stats();
    expect(afterCriterion.sessionsCreated - before.sessionsCreated).toBe(3);
    expect(afterCriterion.sessionsDeleted - before.sessionsDeleted).toBe(3);
    expect(afterCriterion.resourcesCreated - before.resourcesCreated).toBeLessThanOrEqual(
      Number(process.env.PORTAL_COPILOT_POOL_SIZE || 2),
    );
    expect(afterCriterion.used).toBe(0);
    expect(afterCriterion.pendingAcquires).toBe(0);

    const generatedTask = await request(app)
      .post("/api/v1/task-prompts/generate")
      .send({ description: "A small TypeScript REST API with tests." })
      .expect(200);
    expect(generatedTask.body.taskPrompt).toEqual(expect.any(String));

    const variedTask = await request(app)
      .post("/api/v1/task-prompts/generate")
      .send({
        existingPrompt: generatedTask.body.taskPrompt,
        description: "Use Python instead of TypeScript.",
      })
      .expect(200);
    expect(variedTask.body.taskPrompt).toEqual(expect.any(String));

    const generatedFeature = await request(app)
      .post("/api/v1/prompt-features/generate-prompt")
      .send({ behavior: "The task asks for automated tests." })
      .expect(200);
    expect(generatedFeature.body).toEqual({
      prompt: expect.any(String),
      suggestedId: expect.any(String),
      suggestedParents: expect.any(Array),
      suggestedChildren: expect.any(Array),
    });

    const extracted = await request(app)
      .post("/api/v1/prompt-features/extract-from-text")
      .send({
        text: "Create a TypeScript service and include unit tests.",
        type: "select",
      })
      .expect(200);
    expect(extracted.body).toEqual({
      features: expect.any(Array),
      cached: false,
      ...(extracted.body.suggestedFeatures
        ? { suggestedFeatures: expect.any(Array) }
        : {}),
    });

    const after = pool.stats();
    expect(after.sessionsCreated - before.sessionsCreated).toBe(7);
    expect(after.sessionsDeleted).toBe(after.sessionsCreated);
    expect(after.used).toBe(0);
    expect(after.pendingAcquires).toBe(0);
    expect(after.pendingCreates).toBe(0);
  });
});
