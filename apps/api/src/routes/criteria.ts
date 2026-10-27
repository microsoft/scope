// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  CreateCriteriaInputSchema,
  CriteriaGraphSchema,
  CriteriaResponseSchema,
  UpdateCriteriaInputSchema,
  CriteriaStore,
  CriteriaStoreError,
  CriteriaHasDependentsError,
  DependencyGraph,
  type GateId,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import { computeMdp } from "../criteria-mdp.js";
import type { MdpAnalyzableRun } from "../criteria-mdp.js";
import { generateCriteriaPrompt, isLlmAvailable } from "../llm.js";
import { isInferenceError } from "../llm-token.js";
import { ProjectIdQuerySchema, getQueryProjectId } from "../utils/project-scope.js";

/**
 * Map a thrown {@link CriteriaStoreError} to an HTTP response. Returns true when
 * the error was handled; callers should rethrow anything that wasn't.
 */
function sendStoreError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  err: unknown,
): boolean {
  if (err instanceof CriteriaHasDependentsError) {
    res.status(err.status).json({ error: err.message, dependents: err.dependents });
    return true;
  }
  if (err instanceof CriteriaStoreError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

export function registerCriteriaRoutes(ctx: RouteContext): void {

  // Single source of truth for criteria writes (create/update/delete/seed).
  // Built from the live ctx per call so dependency injection (and tests that
  // swap ctx.criteriaCollection) keep working. Pass the resolved project so all
  // reads/writes/DAG traversals are confined to it (same id may exist per-project).
  const getCriteriaStore = (projectId?: string): CriteriaStore =>
    new CriteriaStore(
      ctx.criteriaCollection as unknown as ConstructorParameters<typeof CriteriaStore>[0],
      projectId,
    );

// --- Criteria seed & CRUD (apiRoute) ---

// POST /api/v1/criteria/generate-prompt — AI-generate a criteria prompt
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/criteria/generate-prompt",
  tags: ["Criteria"],
  summary: "Generate criterion prompt from behavior",
  query: ProjectIdQuerySchema,
  body: z.object({
    behavior: z.string(),
    currentId: z.string().optional(),
    gates: z.array(z.string()).optional(),
  }),
  response: z.object({
    prompt: z.string(),
    suggestedId: z.string(),
    suggestedParents: z.array(z.string()),
    suggestedChildren: z.array(z.string()),
  }),
  errorResponses: {
    400: { description: "Empty behavior string" },
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { behavior, currentId, gates } = req.body;
    if (!behavior.trim()) {
      res.status(400).json({ error: "Body must contain a non-empty 'behavior' string" });
      return;
    }

    if (!isLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: no inference backend available. Please register a new secret key for GitHub Model or Azure Foundry." });
      return;
    }

    const allCriteria = await ctx.criteriaCollection
      .find({ projectId: getQueryProjectId(req), deletedAt: { $exists: false } })
      .project({ id: 1, prompt: 1, dependsOn: 1, gates: 1, _id: 0 })
      .toArray();

    const existingCriteria = currentId
      ? allCriteria.filter((c: any) => c.id !== currentId)
      : allCriteria;

    try {
      const result = await generateCriteriaPrompt(
        behavior.trim(),
        existingCriteria as { id: string; prompt: string; dependsOn?: string[]; gates?: GateId[] }[],
        gates as GateId[] | undefined,
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
  query: ProjectIdQuerySchema,
  body: z.object({
    criteria: z.array(CreateCriteriaInputSchema),
  }),
  response: z.object({
    seeded: z.number(),
    errors: z.array(z.string()),
  }),
  errorResponses: {
    400: { description: "Seed batch would introduce a dependency cycle" },
  },
  handler: async (req, res) => {
    const projectId = getQueryProjectId(req);
    const { criteria } = req.body;
    let seeded = 0;
    const errors: string[] = [];

    // Batch cycle guard (D1): validate the set that would result from this seed
    // (existing active criteria + newly inserted ones; existing ids win) has no
    // dependency cycle. Edges to ids absent from the set are filtered out so the
    // seed stays permissive about partial/forward references — only cycles among
    // present nodes reject the whole batch.
    const existingDocs = await ctx.criteriaCollection
      .find({ projectId, deletedAt: { $exists: false } })
      .toArray();
    const merged = new Map<string, { id: string; prompt: string; dependsOn: string[] }>();
    for (const d of existingDocs) {
      merged.set(d.id, { id: d.id, prompt: d.prompt, dependsOn: d.dependsOn ?? [] });
    }
    for (const config of criteria) {
      const id = String(config.id ?? "").trim();
      if (!id || merged.has(id)) continue;
      merged.set(id, {
        id,
        prompt: String(config.prompt ?? "").trim(),
        dependsOn: Array.isArray(config.dependsOn)
          ? config.dependsOn.map((d: unknown) => String(d).trim())
          : [],
      });
    }
    const known = new Set(merged.keys());
    const nodes = Array.from(merged.values()).map((n) => ({
      ...n,
      dependsOn: n.dependsOn.filter((d) => known.has(d)),
    }));
    try {
      new DependencyGraph(nodes);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ycle")) {
        res.status(400).json({
          error: `Seed rejected: the resulting criteria set would contain a dependency cycle (${err.message})`,
        });
        return;
      }
      // Other graph errors (e.g. unknown-node refs) are tolerated — seed is
      // intentionally permissive about references that aren't present yet.
    }

    for (const config of criteria) {
      if (!config.id || !config.prompt) {
        errors.push("Skipping entry without id or prompt");
        continue;
      }
      try {
        await ctx.criteriaCollection.updateOne(
          { projectId, id: config.id.trim() },
          {
            $setOnInsert: {
              projectId,
              id: config.id.trim(),
              prompt: config.prompt.trim(),
              dependsOn: Array.isArray(config.dependsOn)
                ? config.dependsOn.map((d: any) => String(d).trim())
                : [],
              ...(Array.isArray(config.gates) ? { gates: config.gates } : {}),
              createdAt: new Date(),
            },
            $unset: { deletedAt: "" },
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

// GET /api/v1/criteria — list all criteria (with optional ?q= search, ?ids= filter with ancestor resolution)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/criteria",
  tags: ["Criteria"],
  summary: "List criteria",
  query: z.object({
    q: z.string().optional(),
    ids: z.string().optional().describe("Comma-separated criterion IDs to include"),
    ancestors: z.enum(["true", "false"]).optional().describe("When true and ids is set, also include dependency ancestors"),
  }).merge(ProjectIdQuerySchema),
  response: z.array(CriteriaResponseSchema),
  handler: async (req, res) => {
    const q = req.query.q;
    const idsParam = req.query.ids;

    // `q` (regex search) and `ids` (exact set + optional ancestor resolution)
    // are mutually exclusive: applying the regex filter first would silently
    // drop ancestors that don't match `q`, yielding an incomplete dependency tree.
    if (q && idsParam) {
      res.status(400).json({ error: "Query params 'q' and 'ids' are mutually exclusive" });
      return;
    }

    const filter: Record<string, unknown> = {
      projectId: getQueryProjectId(req),
      deletedAt: { $exists: false },
    };
    if (q) {
      filter.$or = [
        { id: { $regex: q, $options: "i" } },
        { prompt: { $regex: q, $options: "i" } },
      ];
    }
    let criteria = await ctx.criteriaCollection.find(filter).toArray();
    criteria.sort((a, b) => a.id.localeCompare(b.id));

    // Filter by IDs with optional ancestor resolution
    if (idsParam) {
      const requestedIds = idsParam.split(",").map(s => s.trim()).filter(Boolean);
      const includeAncestors = req.query.ancestors === "true";

      if (includeAncestors) {
        const byId = new Map(criteria.map(c => [c.id, c]));
        const included = new Set<string>();

        const resolve = (id: string) => {
          if (included.has(id)) return;
          const criterion = byId.get(id);
          if (!criterion) return;
          included.add(id);
          for (const dep of criterion.dependsOn ?? []) {
            resolve(dep);
          }
        };

        for (const id of requestedIds) {
          resolve(id);
        }
        criteria = criteria.filter(c => included.has(c.id));
      } else {
        const idSet = new Set(requestedIds);
        criteria = criteria.filter(c => idSet.has(c.id));
      }
    }

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
  }).merge(ProjectIdQuerySchema),
  response: z.object({}).passthrough(),
  handler: async (req, res) => {
    const selectedCriteria = req.query.criteria
      ? req.query.criteria.split(",").map((c) => c.trim()).filter(Boolean)
      : undefined;
    const selectedFeatures = req.query.features
      ? req.query.features.split(",").map((f) => f.trim()).filter(Boolean)
      : undefined;
    const sinceDate = req.query.since ? new Date(req.query.since) : undefined;

    const mdpProjectId = getQueryProjectId(req);
    const mdpFilter: Record<string, unknown> = {
      projectId: mdpProjectId,
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
        .find({ _id: { $in: taskPromptIds }, projectId: mdpProjectId })
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
  query: ProjectIdQuerySchema,
  response: CriteriaGraphSchema,
  handler: async (req, res) => {
    const all = await ctx.criteriaCollection
      .find({ projectId: getQueryProjectId(req), deletedAt: { $exists: false } })
      .toArray();
    all.sort((a, b) => a.id.localeCompare(b.id));
    const nodes = all.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      dependsOn: c.dependsOn || [],
      ...(c.gates !== undefined ? { gates: c.gates } : {}),
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
  query: ProjectIdQuerySchema,
  response: CriteriaResponseSchema,
  errorResponses: {
    404: { description: "Criterion not found" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const projectId = getQueryProjectId(req);
    const scope = { projectId };
    const criterion = await ctx.criteriaCollection.findOne({
      ...scope,
      id,
      deletedAt: { $exists: false },
    });
    if (!criterion) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
      return;
    }

    const dependents = await ctx.criteriaCollection
      .find({ ...scope, dependsOn: id, deletedAt: { $exists: false } })
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
  query: ProjectIdQuerySchema,
  response: CriteriaResponseSchema,
  errorResponses: {
    409: { description: "Criterion already exists" },
  },
  handler: async (req, res) => {
    const projectId = getQueryProjectId(req);
    const { id, prompt, dependsOn = [], gates } = req.body;
    try {
      const doc = await getCriteriaStore(projectId).create({ projectId, id, prompt, dependsOn, gates });
      res.status(201).json(doc);
    } catch (err) {
      if (!sendStoreError(res, err)) throw err;
    }
  },
});

// PUT /api/v1/criteria/:id — update a criterion
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/criteria/:id",
  tags: ["Criteria"],
  summary: "Update criterion",
  params: z.object({ id: z.string() }),
  query: ProjectIdQuerySchema,
  body: UpdateCriteriaInputSchema,
  response: CriteriaResponseSchema,
  errorResponses: {
    404: { description: "Criterion not found" },
    400: { description: "Invalid dependency reference or self-reference" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const { prompt, dependsOn, gates } = req.body;
    try {
      const updated = await getCriteriaStore(getQueryProjectId(req)).update(id, { prompt, dependsOn, gates });
      res.json(updated);
    } catch (err) {
      if (!sendStoreError(res, err)) throw err;
    }
  },
});

// DELETE /api/v1/criteria/:id — soft-delete (rejects if has dependents)
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/criteria/:id",
  tags: ["Criteria"],
  summary: "Soft-delete criterion",
  params: z.object({ id: z.string() }),
  query: ProjectIdQuerySchema,
  response: z.object({ id: z.string(), deleted: z.boolean() }),
  errorResponses: {
    404: { description: "Criterion not found" },
    409: { description: "Criterion has dependents" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    try {
      await getCriteriaStore(getQueryProjectId(req)).delete(id);
      res.json({ id, deleted: true });
    } catch (err) {
      if (!sendStoreError(res, err)) throw err;
    }
  },
});

}
