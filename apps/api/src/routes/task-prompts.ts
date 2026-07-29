// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { CreateTaskPromptInputSchema, PatchTaskPromptFeatureInputSchema, PromptFeatureResultSchema, SuggestedPromptFeatureSchema, TaskPromptResponseSchema } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import { extractPromptFeatures, isLlmAvailable as isPromptFeatureLlmAvailable } from "../prompt-feature-llm.js";
import { generateTaskPrompt, isTaskPromptLlmAvailable } from "../task-prompt-llm.js";
import { isInferenceError } from "../llm-token.js";

export function registerTaskPromptsRoutes(ctx: RouteContext): void {

// ==========================================
// Task Prompt endpoints
// ==========================================

// POST /api/v1/task-prompts/generate — AI-generate a task prompt from a description or variation
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/task-prompts/generate",
  tags: ["Task Prompts"],
  summary: "Generate task prompts",
  body: z.object({
    description: z.string().optional(),
    existingPrompt: z.string().optional(),
  }),
  response: z.object({ tasks: z.array(z.string()) }),
  successStatus: 200,
  errorResponses: {
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { description, existingPrompt } = req.body;

    if (!isTaskPromptLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: no inference backend available. Please register a new secret key for GitHub Model or Azure Foundry." });
      return;
    }

    // Fetch recent task prompts as context (avoid duplicates)
    const recentPrompts = await ctx.taskPromptCollection
      .find({ deletedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .limit(20)
      .project({ text: 1, _id: 0 })
      .toArray();
    const existingTexts = recentPrompts.map((p: any) => p.text);

    const result = await generateTaskPrompt(
      {
        description: description?.trim(),
        existingPrompt: existingPrompt?.trim(),
      },
      existingTexts,
    );
    console.log("[task-prompts/generate] LLM result:", JSON.stringify(result));
    res.json(result);
  },
});

// GET /api/v1/task-prompts — list all task prompts (paginated, optional search)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/task-prompts",
  tags: ["Task Prompts"],
  summary: "List task prompts",
  query: z.object({
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    search: z.string().optional(),
  }),
  response: z.object({
    items: z.array(TaskPromptResponseSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
  handler: async (req, res, next) => {
    const limit = req.query.limit ?? 50;
    const offset = req.query.offset ?? 0;
    const search = req.query.search;

    const { items, total } = await ctx.taskPromptStore.getAll({ limit, offset, search });
    res.json({ items, total, limit, offset });
  },
});

// GET /api/v1/task-prompts/:id — get a single task prompt by ID
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/task-prompts/:id",
  tags: ["Task Prompts"],
  summary: "Get task prompt",
  params: z.object({ id: z.string() }),
  response: TaskPromptResponseSchema,
  errorResponses: {
    404: { description: "Task prompt not found" },
  },
  handler: async (req, res, next) => {
    const { id } = req.params;
    const taskPrompt = await ctx.taskPromptStore.get(id);
    if (!taskPrompt) {
      res.status(404).json({ error: "Task prompt not found" });
      return;
    }
    res.json(taskPrompt);
  },
});

// POST /api/v1/task-prompts — create (or find existing) task prompt. Idempotent.
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/task-prompts",
  tags: ["Task Prompts"],
  summary: "Create or find task prompt",
  body: CreateTaskPromptInputSchema,
  response: TaskPromptResponseSchema,
  errorResponses: {
    400: { description: "Empty text string" },
  },
  handler: async (req, res, next) => {
    const { text } = req.body;
    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "Body must contain a non-empty 'text' string" });
      return;
    }

    const taskPrompt = await ctx.taskPromptStore.findOrCreate(text);
    res.status(201).json(taskPrompt);
  },
});

// DELETE /api/v1/task-prompts/:id — soft-delete a task prompt
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/task-prompts/:id",
  tags: ["Task Prompts"],
  summary: "Soft-delete task prompt",
  params: z.object({ id: z.string() }),
  response: z.object({ deleted: z.boolean() }),
  errorResponses: {
    404: { description: "Task prompt not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      await ctx.taskPromptStore.delete(id);
      res.json({ deleted: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        res.status(404).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
});

// POST /api/v1/task-prompts/:id/extract-features — extract prompt features for a task prompt
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/task-prompts/:id/extract-features",
  tags: ["Task Prompts"],
  summary: "Extract features from task prompt",
  params: z.object({ id: z.string() }),
  query: z.object({ force: z.string().optional() }),
  body: z.object({ model: z.string().optional() }),
  response: z.object({
    taskPromptId: z.string(),
    features: z.array(PromptFeatureResultSchema),
    featuresExtractedAt: z.coerce.date().optional(),
    suggestedFeatures: z.array(SuggestedPromptFeatureSchema).optional(),
    cached: z.boolean(),
  }),
  successStatus: 200,
  errorResponses: {
    404: { description: "Task prompt not found" },
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { id } = req.params;
    const { model } = req.body;
    const force = req.query.force === "true";

    const taskPrompt = await ctx.taskPromptStore.get(id);
    if (!taskPrompt) {
      res.status(404).json({ error: "Task prompt not found" });
      return;
    }

    // Return cached features if available (unless force re-extraction)
    if (!force && taskPrompt.features && taskPrompt.features.length > 0) {
      res.json({
        taskPromptId: taskPrompt._id,
        features: taskPrompt.features,
        featuresExtractedAt: taskPrompt.featuresExtractedAt,
        cached: true,
      });
      return;
    }

    if (!isPromptFeatureLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: no inference backend available. Please register a new secret key for GitHub Model or Azure Foundry." });
      return;
    }

    const allFeatures = await ctx.promptFeatureCollection
      .find({ deletedAt: { $exists: false } })
      .toArray();

    const featureConfigs = allFeatures.map(f => ({ id: f.id, prompt: f.prompt }));
    try {
      const { results, suggestedFeatures } = await extractPromptFeatures(taskPrompt.text, featureConfigs, model);

      // Store features on the task prompt entity
      const updated = await ctx.taskPromptStore.attachFeatures(id, results);

      res.json({
        taskPromptId: updated._id,
        features: updated.features,
        featuresExtractedAt: updated.featuresExtractedAt,
        suggestedFeatures: suggestedFeatures.length > 0 ? suggestedFeatures : undefined,
        cached: false,
      });
    } catch (err) {
      if (isInferenceError(err)) {
        res.status(503).json({ error: err.message });
        return;
      }
      if (err instanceof Error && err.message.includes("not found")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

// PATCH /api/v1/task-prompts/:id/features/:featureId — toggle a feature's detected flag
apiRoute(ctx.app, ctx.registry, {
  method: "patch",
  path: "/api/v1/task-prompts/:id/features/:featureId",
  tags: ["Task Prompts"],
  summary: "Toggle feature flag on task prompt",
  params: z.object({ id: z.string(), featureId: z.string() }),
  body: PatchTaskPromptFeatureInputSchema,
  response: TaskPromptResponseSchema,
  errorResponses: {
    400: { description: "Invalid detected value" },
    404: { description: "Task prompt or feature not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id, featureId } = req.params;
      const { detected } = req.body;

      if (typeof detected !== "boolean") {
        res.status(400).json({ error: "'detected' must be a boolean" });
        return;
      }

      const updated = await ctx.taskPromptStore.toggleFeature(id, featureId, detected);
      res.json(updated);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

}
