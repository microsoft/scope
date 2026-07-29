// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { CreateCriteriaInputSchema, CriteriaGraphSchema, CriteriaResponseSchema, UpdateCriteriaInputSchema } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { CriteriaDocument, RouteContext } from "../route-context.js";
import { computeMdp } from "../criteria-mdp.js";
import type { MdpAnalyzableRun } from "../criteria-mdp.js";
import { generateCriteriaPrompt, isLlmAvailable } from "../llm.js";
import { isInferenceError } from "../llm-token.js";

export function registerCriteriaRoutes(ctx: RouteContext): void {

// --- Criteria seed & CRUD (apiRoute) ---

// POST /api/v1/criteria/generate-prompt — AI-generate a criteria prompt
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/criteria/generate-prompt",
  tags: ["Criteria"],
  summary: "Generate criterion prompt from behavior",
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
    if (!behavior.trim()) {
      res.status(400).json({ error: "Body must contain a non-empty 'behavior' string" });
      return;
    }

    if (!isLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: no inference backend available. Please register a new secret key for GitHub Model or Azure Foundry." });
      return;
    }

    const allCriteria = await ctx.criteriaCollection
      .find({ deletedAt: { $exists: false } })
      .project({ id: 1, prompt: 1, dependsOn: 1, _id: 0 })
      .toArray();

    const existingCriteria = currentId
      ? allCriteria.filter((c: any) => c.id !== currentId)
      : allCriteria;

    try {
      const result = await generateCriteriaPrompt(
        behavior.trim(),
        existingCriteria as { id: string; prompt: string; dependsOn?: string[] }[],
      );
      console.log("[generate-prompt] LLM result:", JSON.stringify(result));
      res.json(result);
    } catch (err) {
      if (isInferenceError(err)) {
        res.status(503).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

// POST /api/v1/criteria/seed — bulk seed criteria from a JSON array
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/criteria/seed",
  tags: ["Criteria"],
  summary: "Seed criteria in bulk",
  body: z.object({
    criteria: z.array(CreateCriteriaInputSchema),
  }),
  response: z.object({
    seeded: z.number(),
    errors: z.array(z.string()),
  }),
  handler: async (req, res) => {
    const { criteria } = req.body;
    let seeded = 0;
    const errors: string[] = [];

    for (const config of criteria) {
      if (!config.id || !config.prompt) {
        errors.push("Skipping entry without id or prompt");
        continue;
      }
      try {
        await ctx.criteriaCollection.updateOne(
          { id: config.id.trim() },
          {
            $setOnInsert: {
              id: config.id.trim(),
              prompt: config.prompt.trim(),
              dependsOn: Array.isArray(config.dependsOn)
                ? config.dependsOn.map((d: any) => String(d).trim())
                : [],
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );
        seeded++;
      } catch (err) {
        errors.push(`Failed to seed ${config.id}: ${err}`);
      }
    }

    res.json({ seeded, errors });
  },
});

// GET /api/v1/criteria — list all criteria (with optional ?q= search)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/criteria",
  tags: ["Criteria"],
  summary: "List criteria",
  query: z.object({ q: z.string().optional() }),
  response: z.array(CriteriaResponseSchema),
  handler: async (req, res) => {
    const q = req.query.q;
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (q) {
      filter.$or = [
        { id: { $regex: q, $options: "i" } },
        { prompt: { $regex: q, $options: "i" } },
      ];
    }
    const criteria = await ctx.criteriaCollection.find(filter).toArray();
    criteria.sort((a, b) => a.id.localeCompare(b.id));
    res.json(criteria);
  },
});

// GET /api/v1/criteria/mdp — MDP state-transition graph across all runs
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/criteria/mdp",
  tags: ["Criteria"],
  summary: "Compute MDP transitions",
  query: z.object({
    criteria: z.string().optional(),
    features: z.string().optional(),
    since: z.string().optional(),
    worker: z.string().optional(),
    taskPromptId: z.string().optional(),
  }),
  response: z.object({}).passthrough(),
  handler: async (req, res) => {
    const selectedCriteria = req.query.criteria
      ? req.query.criteria.split(",").map((c) => c.trim()).filter(Boolean)
      : undefined;
    const selectedFeatures = req.query.features
      ? req.query.features.split(",").map((f) => f.trim()).filter(Boolean)
      : undefined;
    const sinceDate = req.query.since ? new Date(req.query.since) : undefined;

    const mdpFilter: Record<string, unknown> = {
      "run.status": "done",
      deletedAt: { $exists: false },
    };
    if (req.query.worker) mdpFilter.workerType = req.query.worker;
    if (req.query.taskPromptId) mdpFilter.taskPromptId = req.query.taskPromptId;
    if (sinceDate && !isNaN(sinceDate.getTime())) {
      mdpFilter["run.updatedAt"] = { $gt: sinceDate };
    }

    const runs = await ctx.requestCollection
      .find(mdpFilter)
      .project({
        _id: 1,
        scenario: 1,
        "run.status": 1,
        "run.turns": 1,
        "run.updatedAt": 1,
        taskPromptId: 1,
      })
      .toArray();

    // Batch-lookup task prompts for their features
    const taskPromptIds = [
      ...new Set(runs.map((r) => r.taskPromptId).filter(Boolean)),
    ] as string[];
    const taskPromptFeatures = new Map<
      string,
      Array<{ featureId: string; detected: boolean; evaluated: boolean }>
    >();
    if (taskPromptIds.length > 0) {
      const taskPrompts = await ctx.taskPromptCollection
        .find({ _id: { $in: taskPromptIds } })
        .project({ _id: 1, features: 1 })
        .toArray();
      for (const tp of taskPrompts) {
        if (tp.features && tp.features.length > 0) {
          taskPromptFeatures.set(tp._id, tp.features);
        }
      }
    }

    const mdpRuns: MdpAnalyzableRun[] = runs.map((r) => ({
      scenario: r.scenario,
      status: r.run?.status,
      turns: r.run?.turns,
      updatedAt: r.run?.updatedAt,
      promptFeatures: r.taskPromptId
        ? taskPromptFeatures.get(r.taskPromptId)
        : undefined,
    }));

    const mdpResult = computeMdp(mdpRuns, selectedCriteria, selectedFeatures);
    res.json(mdpResult);
  },
});

// GET /api/v1/criteria/graph — criteria DAG (nodes + edges)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/criteria/graph",
  tags: ["Criteria"],
  summary: "Get criteria DAG",
  response: CriteriaGraphSchema,
  handler: async (_req, res) => {
    const all = await ctx.criteriaCollection
      .find({ deletedAt: { $exists: false } })
      .toArray();
    all.sort((a, b) => a.id.localeCompare(b.id));
    const nodes = all.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      dependsOn: c.dependsOn || [],
    }));
    const edges: { source: string; target: string }[] = [];
    for (const c of all) {
      if (c.dependsOn) {
        for (const parentId of c.dependsOn) {
          edges.push({ source: parentId, target: c.id });
        }
      }
    }
    res.json({ nodes, edges });
  },
});

// GET /api/v1/criteria/:id — get single criterion
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/criteria/:id",
  tags: ["Criteria"],
  summary: "Get criterion",
  params: z.object({ id: z.string() }),
  response: CriteriaResponseSchema,
  errorResponses: {
    404: { description: "Criterion not found" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const criterion = await ctx.criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    if (!criterion) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
      return;
    }

    const dependents = await ctx.criteriaCollection
      .find({ dependsOn: id, deletedAt: { $exists: false } })
      .toArray();

    res.json({ ...criterion, dependents: dependents.map((d) => d.id) });
  },
});

// POST /api/v1/criteria — create a new criterion
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/criteria",
  tags: ["Criteria"],
  summary: "Create criterion",
  body: CreateCriteriaInputSchema,
  response: CriteriaResponseSchema,
  errorResponses: {
    409: { description: "Criterion already exists" },
  },
  handler: async (req, res) => {
    const { id, prompt, dependsOn = [] } = req.body;

    // Check for duplicates
    const existing = await ctx.criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    if (existing) {
      res.status(409).json({ error: `Criteria '${id}' already exists` });
      return;
    }

    // Validate dependency references
    for (const depId of dependsOn) {
      const dep = await ctx.criteriaCollection.findOne({
        id: depId,
        deletedAt: { $exists: false },
      });
      if (!dep) {
        res.status(400).json({ error: `Dependency '${depId}' does not exist` });
        return;
      }
    }

    const doc: CriteriaDocument = {
      id,
      prompt: prompt.trim(),
      dependsOn,
      createdAt: new Date(),
    };

    await ctx.criteriaCollection.insertOne(doc as any);
    res.status(201).json(doc);
  },
});

// PUT /api/v1/criteria/:id — update a criterion
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/criteria/:id",
  tags: ["Criteria"],
  summary: "Update criterion",
  params: z.object({ id: z.string() }),
  body: UpdateCriteriaInputSchema,
  response: CriteriaResponseSchema,
  errorResponses: {
    404: { description: "Criterion not found" },
    400: { description: "Invalid dependency reference or self-reference" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const { prompt, dependsOn } = req.body;

    const existing = await ctx.criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
      return;
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (prompt !== undefined) {
      update.prompt = prompt.trim();
    }
    if (dependsOn !== undefined) {
      // Validate dependency references
      for (const depId of dependsOn) {
        const dep = await ctx.criteriaCollection.findOne({
          id: depId,
          deletedAt: { $exists: false },
        });
        if (!dep) {
          res.status(400).json({ error: `Dependency '${depId}' does not exist` });
          return;
        }
      }
      // Self-reference check
      if (dependsOn.includes(id)) {
        res.status(400).json({ error: "A criterion cannot depend on itself" });
        return;
      }
      update.dependsOn = dependsOn;
    }

    await ctx.criteriaCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: update },
    );

    const updated = await ctx.criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    res.json(updated);
  },
});

// DELETE /api/v1/criteria/:id — soft-delete (rejects if has dependents)
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/criteria/:id",
  tags: ["Criteria"],
  summary: "Soft-delete criterion",
  params: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), deleted: z.boolean() }),
  errorResponses: {
    404: { description: "Criterion not found" },
    409: { description: "Criterion has dependents" },
  },
  handler: async (req, res) => {
    const { id } = req.params;

    const existing = await ctx.criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
      return;
    }

    // Check for dependents
    const dependents = await ctx.criteriaCollection
      .find({ dependsOn: id, deletedAt: { $exists: false } })
      .toArray();

    if (dependents.length > 0) {
      res.status(409).json({
        error: `Cannot delete '${id}': other criteria depend on it`,
        dependents: dependents.map((d) => d.id),
      });
      return;
    }

    await ctx.criteriaCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } },
    );

    res.json({ id, deleted: true });
  },
});

}
