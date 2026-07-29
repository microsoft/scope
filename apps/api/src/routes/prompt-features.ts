// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { CreatePromptFeatureInputSchema, PromptFeatureResponseSchema, PromptFeatureResultSchema, SuggestedPromptFeatureSchema, UpdatePromptFeatureInputSchema } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { PromptFeatureDocument, RouteContext } from "../route-context.js";
import { extractPromptFeatures, generatePromptFeaturePrompt, isLlmAvailable as isPromptFeatureLlmAvailable } from "../prompt-feature-llm.js";
import { isInferenceError } from "../llm-token.js";

export function registerPromptFeaturesRoutes(ctx: RouteContext): void {

// --- Prompt Feature CRUD & extraction ---

// POST /api/v1/prompt-features/generate-prompt — AI-generate a prompt feature prompt from a behavior description
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/prompt-features/generate-prompt",
  tags: ["Prompt Features"],
  summary: "Generate prompt feature from behavior",
  body: z.object({
    behavior: z.string(),
    currentId: z.string().optional(),
  }),
  response: z.object({ prompt: z.string() }),
  errorResponses: {
    400: { description: "Empty behavior string" },
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { behavior, currentId } = req.body;
    if (!behavior || typeof behavior !== "string" || !behavior.trim()) {
      res.status(400).json({ error: "Body must contain a non-empty 'behavior' string" });
      return;
    }

    if (!isPromptFeatureLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: no inference backend available. Please register a new secret key for GitHub Model or Azure Foundry." });
      return;
    }

    const allFeatures = await ctx.promptFeatureCollection
      .find({ deletedAt: { $exists: false } })
      .project({ id: 1, prompt: 1, _id: 0 })
      .toArray();

    const existingFeatures = currentId
      ? allFeatures.filter((f: any) => f.id !== currentId)
      : allFeatures;

    try {
      const result = await generatePromptFeaturePrompt(
        behavior.trim(),
        existingFeatures as { id: string; prompt: string }[],
      );
      console.log("[prompt-features/generate-prompt] LLM result:", JSON.stringify(result));
      res.json(result);
    } catch (err) {
      // Surface inference-time failures (bad endpoint, missing deployment,
      // auth failure, etc.) as a 503 with the underlying message so the
      // Portal can show a useful, actionable error.
      if (isInferenceError(err)) {
        res.status(503).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

// POST /api/v1/prompt-features/seed — bulk seed prompt features from a JSON array
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/prompt-features/seed",
  tags: ["Prompt Features"],
  summary: "Seed prompt features in bulk",
  body: z.object({
    features: z.array(CreatePromptFeatureInputSchema),
  }),
  response: z.object({
    seeded: z.number(),
    errors: z.array(z.string()),
  }),
  handler: async (req, res) => {
    const { features } = req.body;

    let seeded = 0;
    const errors: string[] = [];

    for (const config of features) {
      if (!config.id || !config.prompt) {
        errors.push("Skipping entry without id or prompt");
        continue;
      }
      const trimmedId = String(config.id).trim();
      if (!/^[a-z][a-z0-9_]*$/.test(trimmedId)) {
        errors.push(`Skipping '${trimmedId}': id must start with a lowercase letter and contain only [a-z0-9_]`);
        continue;
      }
      try {
        await ctx.promptFeatureCollection.updateOne(
          { id: trimmedId },
          {
            $setOnInsert: {
              id: trimmedId,
              prompt: config.prompt.trim(),
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );
        seeded++;
      } catch (err) {
        errors.push(`Failed to seed ${config.id}: ${err}`);
      }
    }

    res.json({ seeded, errors });
  },
});

// POST /api/v1/prompt-features/extract-from-text — extract features from raw text without persisting
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/prompt-features/extract-from-text",
  tags: ["Prompt Features"],
  summary: "Extract features from text",
  body: z.object({
    text: z.string(),
    model: z.string().optional(),
  }),
  response: z.object({
    features: z.array(PromptFeatureResultSchema),
    suggestedFeatures: z.array(SuggestedPromptFeatureSchema).optional(),
    cached: z.boolean(),
  }),
  errorResponses: {
    400: { description: "Empty text string" },
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { text, model } = req.body;
    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "Body must contain a non-empty 'text' string" });
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
      const { results, suggestedFeatures } = await extractPromptFeatures(text.trim(), featureConfigs, model);

      res.json({
        features: results,
        suggestedFeatures: suggestedFeatures.length > 0 ? suggestedFeatures : undefined,
        cached: false,
      });
    } catch (err) {
      if (isInferenceError(err)) {
        res.status(503).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

// List all prompt features (with optional search)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/prompt-features",
  tags: ["Prompt Features"],
  summary: "List features",
  query: z.object({ q: z.string().optional() }),
  response: z.array(PromptFeatureResponseSchema),
  handler: async (req, res) => {
    const q = req.query.q;
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (q) {
      filter.$or = [
        { id: { $regex: q, $options: "i" } },
        { prompt: { $regex: q, $options: "i" } },
      ];
    }
    const features = await ctx.promptFeatureCollection.find(filter).toArray();
    features.sort((a, b) => a.id.localeCompare(b.id));
    res.json(features);
  },
});

// Get single prompt feature by ID
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/prompt-features/:id",
  tags: ["Prompt Features"],
  summary: "Get feature",
  params: z.object({ id: z.string() }),
  response: PromptFeatureResponseSchema,
  errorResponses: {
    404: { description: "Feature not found" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const feature = await ctx.promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!feature) {
      res.status(404).json({ error: `Prompt feature '${id}' not found` });
      return;
    }

    res.json(feature);
  },
});

// Create a new prompt feature
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/prompt-features",
  tags: ["Prompt Features"],
  summary: "Create feature",
  body: CreatePromptFeatureInputSchema,
  response: PromptFeatureResponseSchema,
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
    409: { description: "Feature already exists" },
  },
  handler: async (req, res) => {
    const { id, prompt } = req.body;

    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id is required and must be a string" });
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      res.status(400).json({ error: "id must start with a lowercase letter and contain only [a-z0-9_]" });
      return;
    }
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "prompt is required and must be a string" });
      return;
    }

    const existing = await ctx.promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (existing) {
      res.status(409).json({ error: `Prompt feature '${id}' already exists` });
      return;
    }

    const doc: PromptFeatureDocument = {
      id,
      prompt: prompt.trim(),
      createdAt: new Date(),
    };

    await ctx.promptFeatureCollection.insertOne(doc as any);
    res.status(201).json(doc);
  },
});

// Update a prompt feature
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/prompt-features/:id",
  tags: ["Prompt Features"],
  summary: "Update feature",
  params: z.object({ id: z.string() }),
  body: UpdatePromptFeatureInputSchema,
  response: PromptFeatureResponseSchema,
  errorResponses: {
    400: { description: "Invalid input" },
    404: { description: "Feature not found" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const { prompt } = req.body;

    const existing = await ctx.promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!existing) {
      res.status(404).json({ error: `Prompt feature '${id}' not found` });
      return;
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (prompt !== undefined) {
      if (typeof prompt !== "string") {
        res.status(400).json({ error: "prompt must be a string" });
        return;
      }
      update.prompt = prompt.trim();
    }

    await ctx.promptFeatureCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: update }
    );

    const updated = await ctx.promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    res.json(updated);
  },
});

// Delete a prompt feature (soft-delete)
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/prompt-features/:id",
  tags: ["Prompt Features"],
  summary: "Soft-delete feature",
  params: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), deleted: z.boolean() }),
  errorResponses: {
    404: { description: "Feature not found" },
  },
  handler: async (req, res) => {
    const { id } = req.params;

    const existing = await ctx.promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!existing) {
      res.status(404).json({ error: `Prompt feature '${id}' not found` });
      return;
    }

    await ctx.promptFeatureCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    res.json({ id, deleted: true });
  },
});

}
