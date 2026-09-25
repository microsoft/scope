// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import multer from "multer";
import { BlobServiceClient, BlockBlobClient, RestError } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { createGzip, createGunzip } from "zlib";
import { join, basename } from "path";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, existsSync } from "fs";
import { pack as tarPack, extract as tarExtract } from "tar-stream";
import { parse as yamlParse } from "yaml";
import { tmpdir } from "os";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  BulkResubmitInputSchema,
  CreateRequestInputSchema,
  ExtensionClient,
  EMPTY_FILTER_VALUE,
  ListRequestsQuerySchema,
  MULTI_TURN_DEFAULTS,
  PaginatedRunGroupsResponseSchema,
  PaginatedRunsResponseSchema,
  ReportResponseSchema,
  RequestResponseSchema,
  RunFacetsResponseSchema,
  RunStateSchema,
  decodeCursor,
  encodeCursor,
  runDurationMs,
  parseExtensionSpec,
  parseProfileSpec,
  resolveResourceParams,
  validateGateConfigs,
  isCriterionCompatibleWithGate,
  orderGates,
  computeTaskPromptId,
} from "shared";
import type {
  ProfileDocument,
  ProfileVersionDocument,
  GateConfig,
  GateId,
  ResourceBinding,
  ResourceBindingSpec,
  ResourceRevisionDocument,
} from "shared";
import { apiRoute } from "../../openapi/api-route.js";
import type {
  ExtensionDocument,
  McpServerDocument,
  RequestDocument,
  RouteContext,
  WorkerType,
} from "../../route-context.js";
import { computeAnalysis, capRunsToLimit } from "../../analysis.js";
import type { AnalysisResponse, AnalyzableRun } from "../../analysis.js";
import { parseStateKey } from "../../criteria-mdp.js";
import { buildGroupingPipeline } from "../../grouping.js";
import {
  buildMultiClause,
  buildSearchClause,
  buildSeek,
  buildSortObject,
  deserializeSortValue,
  parseMulti,
  resolveSortField,
  serializeSortValue,
  sortValueOf,
} from "./run-query.js";
import { resolveSkillSpecs } from "../../utils/skill-helpers.js";
import { findMissingExtensionSlugs } from "../../utils/extension-helpers.js";
import { resolveCodebaseSpec, createCodebaseArchiveUploader } from "../../utils/codebase-helpers.js";
import {
  packRunIntoTar,
} from "../../archive-har.js";
import { insertHistoricalRun, listHistoricalRuns, getHistoricalRun } from "../../runs-repo.js";
import { ProjectIdQuerySchema, getQueryProjectId } from "../../utils/project-scope.js";
import type { RunState } from "shared";
import {
  requestedAgentCapabilities,
  validateAgentTarget,
} from "../../utils/agent-helpers.js";

type RequestCollection = RouteContext["requestCollection"];
type RunFacetsResponse = z.infer<typeof RunFacetsResponseSchema>;
type RunFacetKey = (typeof RUN_FACET_DIMS)[number]["key"];

/**
 * Categorical dimensions exposed by the Runs filter rail. Each has a single-field
 * index, but Cosmos serves no index-only GROUP BY, so the $group below loads every
 * matched document regardless — which is why the result is cached (see below).
 */
const RUN_FACET_DIMS = [
  { key: "workerType", field: "workerType" },
  { key: "status", field: "run.status" },
  { key: "outcome", field: "run.outcome" },
  { key: "model", field: "model" },
  { key: "os", field: "run.os.platform" },
  { key: "priority", field: "priority" },
  { key: "agentVersion", field: "agentVersion" },
  { key: "profileId", field: "profileId" },
] as const;

/**
 * Compute the Runs filter-rail facets: every distinct value and its count per
 * categorical dimension.
 *
 * The counts are an **absolute** distribution over all non-deleted runs — they
 * deliberately ignore the active search, date range, iteration, and categorical
 * selections. Since the rail already keeps every value visible regardless of the
 * current selection, scoping the counts to the query would only add cost (each
 * $group is a full scan on Cosmos — there is no index-only grouping) for an
 * inconsistent, half-reactive number. Being input-independent also makes the
 * whole response trivially cacheable process-wide (see {@link getRunFacets}).
 */
async function computeRunFacets(col: RequestCollection, projectId: string): Promise<RunFacetsResponse> {
  const match = { deletedAt: { $exists: false }, projectId };
  const dimResults = await Promise.all(
    RUN_FACET_DIMS.map((d) =>
      col
        .aggregate<{ _id: unknown; count: number }>([
          { $match: match },
          { $group: { _id: `$${d.field}`, count: { $sum: 1 } } },
        ])
        .toArray(),
    ),
  );

  const facets = {
    workerType: [], status: [], outcome: [], model: [], os: [], priority: [], agentVersion: [], profileId: [],
  } as Record<RunFacetKey, { value: string; count: number }[]>;
  RUN_FACET_DIMS.forEach((d, i) => {
    facets[d.key] = dimResults[i]
      .map((r) => ({
        value: r._id === null || r._id === undefined ? EMPTY_FILTER_VALUE : String(r._id),
        count: r.count,
      }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  });

  // Every run lands in exactly one bucket per dimension (null included), so the
  // counts of any single dimension sum to the run total — no countDocuments needed.
  const total = dimResults[0].reduce((sum, r) => sum + r.count, 0);

  return { total, facets };
}

/**
 * Short TTL for the per-project facets cache. The facets are an absolute,
 * input-independent distribution **within a project**, so one entry per project
 * serves every caller (all tabs, the periodic client refetch, rapid filter
 * toggling) and Cosmos recomputes the 8-way $group fan-out at most once per
 * window per project per API replica.
 */
const RUN_FACETS_CACHE_TTL_MS = 60_000;
const runFacetsCache = new Map<string, { expiresAt: number; promise: Promise<RunFacetsResponse> }>();

function getRunFacets(col: RequestCollection, projectId: string): Promise<RunFacetsResponse> {
  const now = Date.now();
  const cached = runFacetsCache.get(projectId);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  // Cache the in-flight promise so concurrent callers on a cold/expired entry
  // share a single computation rather than stampeding Cosmos.
  const promise = computeRunFacets(col, projectId);
  runFacetsCache.set(projectId, { expiresAt: now + RUN_FACETS_CACHE_TTL_MS, promise });
  promise.catch(() => {
    // Drop a rejected entry so the next request retries instead of serving the error.
    if (runFacetsCache.get(projectId)?.promise === promise) runFacetsCache.delete(projectId);
  });
  return promise;
}

/** Test-only: reset the per-project facets cache so each test computes fresh. */
export function _resetRunFacetsCacheForTests(): void {
  runFacetsCache.clear();
}

/**
 * Decide where a resubmit's resources come from.
 *
 * A resubmit must reproduce the original environment, so pinned bindings are
 * preserved by default — re-resolving would let a run pinned to `simulator@r1`
 * with `REPO=run/repo` come back as `simulator@r2` with the revision's default,
 * fail 422 if that parameter is required, or lose its resources entirely if the
 * profile declares none.
 *
 * Only an explicitly supplied replacement profile re-resolves. This is keyed off
 * `overrideProfileId` rather than off the resolved profile version, because the
 * latter is also populated when the caller simply keeps the original profile.
 *
 * @param overrideProfileId - `undefined` keeps the original profile, `null`
 *   detaches it, and a string selects a replacement.
 */
export function planResubmitResources(
  overrideProfileId: string | null | undefined,
  originalResources: ResourceBinding[] | undefined,
  profileResourceSpecs: ResourceBindingSpec[] | undefined,
):
  | { kind: "preserve"; bindings: ResourceBinding[] | null }
  | { kind: "resolve"; specs: ResourceBindingSpec[] } {
  if (typeof overrideProfileId === "string") {
    return profileResourceSpecs && profileResourceSpecs.length > 0
      ? { kind: "resolve", specs: profileResourceSpecs }
      : { kind: "preserve", bindings: null };
  }
  return {
    kind: "preserve",
    bindings: originalResources && originalResources.length > 0 ? originalResources : null,
  };
}

export function registerRequestsRoutes(ctx: RouteContext): void {

const upload = multer({ dest: tmpdir() });

const validatePersistedRequestTarget = (request: RequestDocument) =>
  validateAgentTarget(ctx.agentCollection, {
    workerType: request.workerType,
    requestedVersion: request.agentVersion,
    model: request.model,
    requirements: requestedAgentCapabilities({
      reasoningEffort: request.reasoningEffort,
      mcpServers: request.mcpServers,
      skillRevisions: request.skillRevisions,
      extensions: request.extensions,
      resources: request.resources,
    }),
    strictCapabilities: ctx.strictAgentCapabilities,
  });

/** Maximum number of profile variations (including the base profile) allowed in one submit. */
const MAX_PROFILE_VARIATIONS = 25;

/**
 * Server-side validation of a request's gate configuration (docs/design/gates.md
 * §4.3). Returns an error string when invalid, or null when valid.
 *
 * Store-backed checks layered on top of the pure `validateGateConfigs` shape
 * check: every criterion must exist and be compatible with its gate, and every
 * gate's prompt must resolve to a prompt whose `type` equals the gate. The
 * downward-closed compatibility invariant (enforced by the criteria editor)
 * guarantees a compatible criterion's ancestors are also compatible, so no
 * extra dependency check is needed here.
 */
async function validateGatesForSubmit(
  ctx: RouteContext,
  gates: GateConfig[],
  defaultMaxIterations: number | undefined,
  projectId: string,
): Promise<string | null> {
  const shapeErrors = validateGateConfigs(gates, defaultMaxIterations);
  if (shapeErrors.length > 0) return shapeErrors.join(" ");

  // Collect all referenced criterion ids and resolve them in one query, scoped
  // to the run's project so a gate can only reference criteria in its project.
  const allCriterionIds = [...new Set(gates.flatMap((g) => g.criteria ?? []))];
  const criteriaDocs = allCriterionIds.length
    ? await ctx.criteriaCollection.find({ id: { $in: allCriterionIds }, projectId }).toArray()
    : [];
  const criteriaById = new Map(criteriaDocs.map((c) => [c.id, c]));

  for (const gc of gates) {
    for (const cid of gc.criteria ?? []) {
      const doc = criteriaById.get(cid);
      if (!doc) {
        return `Gate '${gc.gate}' references unknown criterion '${cid}'.`;
      }
      if (!isCriterionCompatibleWithGate(doc.gates as GateId[] | undefined, gc.gate)) {
        return `Criterion '${cid}' is not compatible with the '${gc.gate}' gate.`;
      }
    }

    // Every configured gate must reference a prompt whose type === gate.
    // The Select gate's prompt is the request task (resolved separately and
    // guaranteed to exist), so its prompt is not checked here.
    if (gc.gate === "select") continue;
    if (!gc.promptId) {
      return `Gate '${gc.gate}' is missing a prompt.`;
    }
    const prompt = await ctx.taskPromptCollection.findOne({ _id: gc.promptId, projectId });
    if (!prompt) {
      return `Gate '${gc.gate}' references unknown prompt '${gc.promptId}'.`;
    }
    // Legacy prompts without a type are treated as 'select'.
    const promptType = (prompt as { type?: string }).type ?? "select";
    if (promptType !== gc.gate) {
      return `Gate '${gc.gate}' prompt '${gc.promptId}' has type '${promptType}' (expected '${gc.gate}').`;
    }
  }

  return null;
}

/**
 * Materialize free-text gate prompts into typed prompt entities (docs/design/
 * gates.md §4.3/§4.4). For every non-Select gate that supplies `promptText`, the
 * text is content-addressed via `taskPromptStore.findOrCreate(text, gate)` —
 * idempotent and parallel to how the request task prompt is materialized — and
 * the resulting id is written to `promptId`. `promptText` supersedes any provided
 * `promptId` (an edited prompt wins over a stale picked id) and is stripped from
 * the returned config so it never reaches the persisted/running gate.
 *
 * The Select gate is left untouched here: its prompt is the request task, which
 * is resolved separately and stamped onto the Select gate's `promptId` later.
 */
async function resolveGatePromptText(
  ctx: RouteContext,
  gates: GateConfig[],
  projectId: string,
): Promise<GateConfig[]> {
  return Promise.all(
    gates.map(async (gc) => {
      const text = gc.promptText?.trim();
      if (gc.gate === "select" || !text) {
        // Drop any stray promptText so it never persists.
        const { promptText: _ignored, ...rest } = gc;
        return rest;
      }
      const prompt = await ctx.taskPromptStore.findOrCreate(projectId, text, gc.gate);
      const { promptText: _ignored, ...rest } = gc;
      return { ...rest, promptId: prompt._id };
    }),
  );
}

type ResourceBindingSpecInput = string | ResourceBindingSpec;

function normalizeResourceBindingSpec(input: ResourceBindingSpecInput): ResourceBindingSpec {
  return typeof input === "string" ? { ref: input } : input;
}

function normalizeResourceBindingSpecs(input: unknown): ResourceBindingSpec[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const specs = input
    .map((item) => {
      if (typeof item === "string") {
        const ref = item.trim();
        return ref ? { ref } : undefined;
      }
      if (item && typeof item === "object" && typeof (item as { ref?: unknown }).ref === "string") {
        const ref = (item as { ref: string }).ref.trim();
        if (!ref) return undefined;
        const params = (item as { params?: unknown }).params;
        return {
          ref,
          ...(params && typeof params === "object" ? { params: params as Record<string, string> } : {}),
        };
      }
      return undefined;
    })
    .filter((spec): spec is ResourceBindingSpec => spec !== undefined);
  return specs.length > 0 ? specs : undefined;
}

async function resolveResourceRevision(
  ctx: RouteContext,
  projectId: string,
  spec: string,
): Promise<ResourceRevisionDocument | null> {
  const at = spec.lastIndexOf("@r");
  const slug = at > 0 ? spec.slice(0, at) : spec;
  const revisionNumber = at > 0 ? Number(spec.slice(at + 2)) : undefined;

  let revision: ResourceRevisionDocument | null = null;
  if (revisionNumber !== undefined && Number.isInteger(revisionNumber) && revisionNumber > 0) {
    const resource = await ctx.resourceStore.getBySlug(projectId, slug);
    revision = resource
      ? await ctx.resourceRevisionStore.getByNumber(resource._id, revisionNumber)
      : null;
  } else {
    // A bare spec is a slug or a revision id; try both before failing.
    const resource = await ctx.resourceStore.getBySlug(projectId, spec);
    revision = resource
      ? await ctx.resourceRevisionStore.getLatest(resource._id)
      : await ctx.resourceRevisionStore.get(spec);
  }

  if (revision && revision.projectId !== projectId) return null;
  return revision;
}

async function resolveResourceBindings(
  ctx: RouteContext,
  projectId: string,
  requestedSpecs: ResourceBindingSpec[] | undefined,
  profileSpecs: ResourceBindingSpec[] | undefined,
): Promise<{ bindings?: ResourceBinding[]; conflicts: string[]; errors: string[] }> {
  const conflicts: string[] = [];
  const errors: string[] = [];
  const effectiveSpecs = profileSpecs ?? requestedSpecs;
  if (!effectiveSpecs || effectiveSpecs.length === 0) return { conflicts, errors };

  if (profileSpecs && requestedSpecs && requestedSpecs.length > profileSpecs.length) {
    conflicts.push(`resources: sent ${requestedSpecs.length} binding(s), profile requires ${profileSpecs.length}`);
  }

  const bindings: ResourceBinding[] = [];
  for (let index = 0; index < effectiveSpecs.length; index += 1) {
    const profileSpec = profileSpecs?.[index];
    const runSpec = requestedSpecs?.[index];
    const effectiveSpec = normalizeResourceBindingSpec(profileSpec ?? runSpec!);

    const revision = await resolveResourceRevision(ctx, projectId, effectiveSpec.ref);
    if (!revision) {
      errors.push(`Resource '${effectiveSpec.ref}' not found in this project`);
      continue;
    }

    let runParams = runSpec?.params;
    if (profileSpec && runSpec) {
      const normalizedRunSpec = normalizeResourceBindingSpec(runSpec);
      const runRevision = await resolveResourceRevision(ctx, projectId, normalizedRunSpec.ref);
      if (!runRevision) {
        errors.push(`Resource '${normalizedRunSpec.ref}' not found in this project`);
        runParams = undefined;
      } else if (runRevision._id !== revision._id) {
        conflicts.push(`resources[${index}].ref: sent "${normalizedRunSpec.ref}", profile requires "${effectiveSpec.ref}"`);
        runParams = undefined;
      }
    }

    const result = resolveResourceParams({
      parameters: revision.parameters,
      profileParams: profileSpec?.params,
      runParams,
      ref: revision.ref,
    });
    conflicts.push(...result.conflicts);
    errors.push(...result.errors);
    bindings.push({
      ref: revision.ref,
      revisionId: revision._id,
      params: result.params,
    });
  }

  return { bindings, conflicts, errors };
}

// Submit a request
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests",
  tags: ["Requests"],
  summary: "Submit request(s)",
  body: CreateRequestInputSchema.extend({
    count: z.number().min(1).max(10).default(1),
    skills: z.array(z.string()).optional(),
    agentVersion: z.string().optional(),
    codebase: z.string().optional(),
  }),
  query: ProjectIdQuerySchema,
  response: z.union([RequestResponseSchema, z.array(RequestResponseSchema)]),
  successStatus: 201,
  handler: async (req, res) => {
    const projectId = getQueryProjectId(req);
    const { scenario: scenarioObj, persona: personaObj, maxIterations, personaInstructions, count = 1, model: requestedModel, reasoningEffort: requestedReasoningEffort, mcpServers: mcpServerSlugs, skills: skillSlugs, extensions: extensionIds, agentVersion: requestedAgentVersion, profileId: requestedProfileSpec, profileVariations, priority: requestedPriority, agentsMd: requestedAgentsMd, agentsMdParentIds: requestedAgentsMdParentIds, gates: requestedGates, codebase: codebaseSpec, codebaseRevisionId: requestedCodebaseRevisionId, resources: resourceSpecs } = req.body;
    let worker = req.query.worker as string | undefined;

    // AGENTS.md body + lineage (for any caller that wants to attach an
    // AGENTS.md instruction file to a run).
    const agentsMdText =
      typeof requestedAgentsMd === "string" && requestedAgentsMd.trim()
        ? requestedAgentsMd
        : undefined;
    const agentsMdParentIds = Array.isArray(requestedAgentsMdParentIds)
      ? requestedAgentsMdParentIds.filter((x: unknown): x is string => typeof x === "string")
      : undefined;

    // Resolve the AGENTS.md body to an `agents.md`-typed prompt id (idempotent,
    // content-addressed; large bodies are offloaded to blob by the store).
    const resolveAgentsMdPromptId = async (): Promise<string | undefined> => {
      if (!agentsMdText) return undefined;
      const p = await ctx.taskPromptStore.findOrCreate(projectId, agentsMdText, "agents.md");
      return p._id;
    };

    // Common request fields for AGENTS.md delivery + lineage.
    const buildAgentsMdFields = (agentsMdPromptId?: string) => ({
      ...(agentsMdPromptId ? { agentsMdPromptId } : {}),
      ...(agentsMdParentIds && agentsMdParentIds.length ? { agentsMdParentIds } : {}),
    });

    // Resolve the optional per-run codebase selection into a concrete revision id.
    // Accepts an already-resolved `codebaseRevisionId`, or a `codebase` spec
    // (revision id / `{slug}@r{N}` ref / bare slug). A bare git slug resolves the
    // default branch and creates a new incremental revision at submit time.
    let resolvedCodebaseRevisionId: string | undefined;
    {
      const spec = (codebaseSpec ?? requestedCodebaseRevisionId)?.trim();
      if (spec) {
        const uploadArchive = createCodebaseArchiveUploader({
          storageConnectionString: ctx.storageConnectionString,
          storageAccountName: ctx.storageAccountName,
        });
        const result = await resolveCodebaseSpec(spec, {
          codebaseStore: ctx.codebaseStore,
          codebaseRevisionStore: ctx.codebaseRevisionStore,
          codebaseResolver: ctx.codebaseResolver,
          uploadArchive,
        });
        if (result.error || !result.revisionId) {
          res.status(400).json({ error: result.error ?? "Failed to resolve codebase" });
          return;
        }
        resolvedCodebaseRevisionId = result.revisionId;
      }
    }

    const requestedResourceSpecs = normalizeResourceBindingSpecs(resourceSpecs);

    type VariationInput = {
      profileId: string;
      profileVersion?: number;
      label?: string;
    };

    const typedProfileVariations: string[] = Array.isArray(profileVariations)
      ? profileVariations.filter((v: unknown): v is string => typeof v === "string")
      : [];
    const isVariationSubmit = typedProfileVariations.length > 0;

    if (isVariationSubmit) {
      if (!requestedProfileSpec) {
        res.status(400).json({ error: "profileId (the base profile) is required when profileVariations are provided" });
        return;
      }

      // In variation mode, controlled fields come from the variation profiles themselves.
      if (requestedModel !== undefined || mcpServerSlugs !== undefined || skillSlugs !== undefined || extensionIds !== undefined) {
        res.status(400).json({
          error: "In variation mode, model/mcpServers/skills/extensions must be set via the variation profile.",
        });
        return;
      }

      // In variation mode, the worker is derived per-variation from each profile's workerType.
      // Reject the ?worker= query param so callers don't think it has any effect.
      if (worker) {
        res.status(400).json({
          error: "The ?worker query parameter is not allowed in variation mode; worker is derived from each variation profile.",
        });
        return;
      }

      if (!scenarioObj || typeof scenarioObj !== "object" || !scenarioObj.task || typeof scenarioObj.task !== "string") {
        res.status(400).json({ error: "scenario.task is required and must be a string" });
        return;
      }

      if (scenarioObj.criteria !== undefined) {
        if (!Array.isArray(scenarioObj.criteria) || !scenarioObj.criteria.every((c: unknown) => typeof c === "string")) {
          res.status(400).json({ error: "scenario.criteria must be an array of strings" });
          return;
        }
      }

      const effectiveMaxIter = maxIterations ?? MULTI_TURN_DEFAULTS.MAX_ITERATIONS;
      if (effectiveMaxIter !== 1) {
        if (!scenarioObj.criteria || !Array.isArray(scenarioObj.criteria) || scenarioObj.criteria.length === 0) {
          res.status(400).json({ error: "At least one criterion is required in scenario.criteria when maxIterations > 1" });
          return;
        }
      }

      const baseParsed = (() => {
        try { return parseProfileSpec(requestedProfileSpec); }
        catch (err) { res.status(400).json({ error: (err as Error).message }); return null; }
      })();
      if (!baseParsed) return;
      const baseProfileId = baseParsed.profileId;
      const baseProfile = await ctx.profileCollection.findOne({
        _id: baseProfileId,
        deletedAt: { $exists: false },
      });
      if (!baseProfile) {
        res.status(404).json({ error: `Profile not found: ${baseProfileId}` });
        return;
      }

      const variationEntries: VariationInput[] = [
        { profileId: baseProfileId, profileVersion: baseParsed.version, label: "base" },
      ];
      for (const spec of typedProfileVariations) {
        let parsed: { profileId: string; version?: number };
        try { parsed = parseProfileSpec(spec); }
        catch (err) { res.status(400).json({ error: (err as Error).message }); return; }
        variationEntries.push({ profileId: parsed.profileId, profileVersion: parsed.version });
      }

      if (variationEntries.length > MAX_PROFILE_VARIATIONS) {
        res.status(400).json({ error: `A maximum of ${MAX_PROFILE_VARIATIONS} variations (including base profile) is supported` });
        return;
      }

      const scenario: RequestDocument["scenario"] = {
        task: scenarioObj.task as string,
        criteria: Array.isArray(scenarioObj.criteria) ? (scenarioObj.criteria as string[]) : [],
        ...(scenarioObj.version === "v1" || scenarioObj.version === "v2" ? { version: scenarioObj.version } : {}),
      };

      const mode = scenario.criteria.length > 0 ? "multi-turn" : "one-shot";
      const taskPrompt = await ctx.taskPromptStore.findOrCreate(projectId, scenario.task);
      const taskPromptId = taskPrompt._id;

      // Gates are the shared evaluation harness for the whole comparative
      // submission, not a per-variation controlled field: every variation
      // (including the base) runs the same gate configuration. Resolve, validate
      // and canonicalize them up front so an invalid config fails the whole
      // submit before any inserts (docs/design/gates.md §4.3), mirroring the
      // single-profile branch below.
      const variationGatesProvided = Array.isArray(requestedGates) && requestedGates.length > 0;
      let persistedVariationGates: GateConfig[] | undefined;
      if (variationGatesProvided) {
        const resolvedGates = await resolveGatePromptText(ctx, requestedGates as GateConfig[], projectId);
        const gateError = await validateGatesForSubmit(ctx, resolvedGates, maxIterations, projectId);
        if (gateError) {
          res.status(400).json({ error: gateError });
          return;
        }
        // Order canonically and point the Select gate's prompt at the resolved
        // task prompt, identical to the single-profile path.
        persistedVariationGates = orderGates(resolvedGates).map((g) =>
          g.gate === "select" ? { ...g, promptId: taskPromptId } : g,
        );
      }

      // Per-variation resolved config — collected in pass 1 so we can fail
      // the whole submit atomically before any insert.
      type ResolvedVariation = {
        entry: VariationInput;
        profile: ProfileDocument;
        profileVersion: ProfileVersionDocument;
        workerType: WorkerType;
        model?: string;
        agentVersion: string;
        mcpServers?: string[];
        skillRevisions?: string[];
        resources?: ResourceBinding[];
        extensions?: string[];
      };

      // Pass 1: validate and resolve every variation. No writes yet.
      const resolved: ResolvedVariation[] = [];
      for (const variationEntry of variationEntries) {
        const variationProfile = await ctx.profileCollection.findOne({
          _id: variationEntry.profileId,
          deletedAt: { $exists: false },
        });
        if (!variationProfile) {
          res.status(404).json({ error: `Profile not found: ${variationEntry.profileId}` });
          return;
        }

        const variationProfileVersion = await ctx.profileVersionCollection.findOne({
          profileId: variationProfile._id,
          version: variationEntry.profileVersion ?? variationProfile.latestVersion,
        });
        if (!variationProfileVersion) {
          res.status(404).json({
            error: `Profile version not found for profile: ${variationEntry.profileId}`,
            requestedVersion: variationEntry.profileVersion ?? variationProfile.latestVersion,
          });
          return;
        }

        const variationWorkerType = variationProfileVersion.workerType as WorkerType;
        const effectiveMcpServers = variationProfileVersion.mcpServers ?? undefined;
        const effectiveSkills = variationProfileVersion.skillRevisions ?? undefined;
        const effectiveExtensions = variationProfileVersion.extensions ?? undefined;
        const requestedVariationAgentVersion = variationProfileVersion.agentVersion ?? requestedAgentVersion;
        const targetCheck = await validateAgentTarget(ctx.agentCollection, {
          workerType: variationWorkerType,
          requestedVersion: requestedVariationAgentVersion,
          model: variationProfileVersion.model,
          requireModel: true,
          requirements: requestedAgentCapabilities({
            reasoningEffort:
              variationProfileVersion.reasoningEffort ?? requestedReasoningEffort,
            mcpServers: effectiveMcpServers,
            skillRevisions: effectiveSkills,
            extensions: effectiveExtensions,
            // Mirrors resolveResourceBindings' precedence (profile wins). Uses the
            // specs rather than resolved bindings because the capability check only
            // needs to know whether any resource was requested, and resolution
            // happens after this point.
            resources:
              normalizeResourceBindingSpecs(variationProfileVersion.resources)
              ?? requestedResourceSpecs,
          }),
          strictCapabilities: ctx.strictAgentCapabilities,
        });
        if (!targetCheck.ok) {
          const { ok: _ok, status, ...payload } = targetCheck;
          res.status(status).json({
            ...payload,
            variationProfileId: variationEntry.profileId,
          });
          return;
        }

        let validatedMcpServers: string[] | undefined;
        if (effectiveMcpServers !== undefined && effectiveMcpServers.length > 0) {
          const existingServers = await ctx.mcpServerCollection
            .find({
              projectId,
              $or: [{ slug: { $in: effectiveMcpServers } }, { _id: { $in: effectiveMcpServers } }],
              deletedAt: { $exists: false },
            })
            .toArray();
          const existingSlugs = new Set(existingServers.map((s: McpServerDocument) => s.slug ?? s._id));
          const missingSlugs = effectiveMcpServers.filter((slug: string) => !existingSlugs.has(slug));
          if (missingSlugs.length > 0) {
            res.status(400).json({
              error: `MCP server(s) not found: ${missingSlugs.join(", ")}`,
              variationProfileId: variationEntry.profileId,
            });
            return;
          }
          validatedMcpServers = effectiveMcpServers;
        }

        let resolvedSkillRevisions: string[] | undefined;
        if (effectiveSkills !== undefined && effectiveSkills.length > 0) {
          const result = await resolveSkillSpecs(effectiveSkills, ctx, projectId);
          if (result.error) {
            const status = result.error.startsWith("Failed to resolve") ? 422 : 400;
            res.status(status).json({ error: result.error, variationProfileId: variationEntry.profileId });
            return;
          }
          resolvedSkillRevisions = result.refs;
        }

        let validatedExtensions: string[] | undefined;
        if (effectiveExtensions !== undefined && effectiveExtensions.length > 0) {
          const parsedSpecs = effectiveExtensions.map((spec: string) => parseExtensionSpec(spec));
          const bareIds = parsedSpecs.map((s) => s.id);
          const missingIds = await findMissingExtensionSlugs(bareIds, ctx.extensionCollection, projectId);
          if (missingIds.length > 0) {
            res.status(400).json({
              error: `Extension(s) not found: ${missingIds.join(", ")}`,
              variationProfileId: variationEntry.profileId,
            });
            return;
          }

          const extensionClient = new ExtensionClient("");
          const resolvedSpecs: string[] = [];
          for (const spec of parsedSpecs) {
            if (spec.version) {
              resolvedSpecs.push(`${spec.id}@${spec.version}`);
            } else {
              const versions = await extensionClient.getVersions(spec.id, false);
              if (versions.length === 0) {
                res.status(422).json({
                  error: `No stable versions found for extension "${spec.id}"`,
                  variationProfileId: variationEntry.profileId,
                });
                return;
              }
              resolvedSpecs.push(`${spec.id}@${versions[0].version}`);
            }
          }
          validatedExtensions = resolvedSpecs;
        }

        const resourceResult = await resolveResourceBindings(
          ctx,
          projectId,
          requestedResourceSpecs,
          normalizeResourceBindingSpecs(variationProfileVersion.resources),
        );
        if (resourceResult.errors.length > 0) {
          res.status(400).json({
            error: resourceResult.errors.join("; "),
            errors: resourceResult.errors,
            variationProfileId: variationEntry.profileId,
          });
          return;
        }
        if (resourceResult.conflicts.length > 0) {
          res.status(400).json({
            error: `Profile "${variationEntry.profileId}" controls these fields. Either omit them or match the profile values.`,
            conflicts: resourceResult.conflicts,
            variationProfileId: variationEntry.profileId,
          });
          return;
        }

        resolved.push({
          entry: variationEntry,
          profile: variationProfile,
          profileVersion: variationProfileVersion,
          workerType: variationWorkerType,
          model: targetCheck.model,
          agentVersion: targetCheck.agentVersion,
          mcpServers: validatedMcpServers,
          skillRevisions: resolvedSkillRevisions,
          resources: resourceResult.bindings,
          extensions: validatedExtensions,
        });
      }

      // Pass 2: build documents and insert them under a single shared submissionId.
      // All variations belong to the same comparative submission so consumers can
      // group them via `submissionId` (matches docs/architecture/app-design.md).
      const submissionId = uuidv4();
      const allNewIds: string[] = [];
      const newDocs: RequestDocument[] = [];
      const variationResults: Array<{ profileId: string; label?: string; ids: string[] }> = [];
      const agentsMdPromptId = await resolveAgentsMdPromptId();
      const agentsMdFields = buildAgentsMdFields(agentsMdPromptId);

      for (const r of resolved) {
        const newIds: string[] = [];
        for (let i = 0; i < count; i++) {
          const requestId = uuidv4();
          const runId = uuidv4();
          newIds.push(requestId);
          allNewIds.push(requestId);

          const requestDoc: RequestDocument = {
            _id: requestId,
            projectId,
            scenario,
            workerType: r.workerType,
            taskPromptId,
            createdAt: new Date(),
            priority: requestedPriority ?? 0,
            ...(r.model ? { model: r.model } : {}),
            ...((r.profileVersion.reasoningEffort ?? requestedReasoningEffort)
              ? { reasoningEffort: r.profileVersion.reasoningEffort ?? requestedReasoningEffort }
              : {}),
            ...(maxIterations ? { maxIterations } : {}),
            ...(personaInstructions ? { personaInstructions } : {}),
            ...(personaObj ? { persona: personaObj } : {}),
            ...(r.mcpServers ? { mcpServers: r.mcpServers } : {}),
            ...(r.skillRevisions ? { skillRevisions: r.skillRevisions } : {}),
            ...(resolvedCodebaseRevisionId ? { codebaseRevisionId: resolvedCodebaseRevisionId } : {}),
            ...(r.resources ? { resources: r.resources } : {}),
            ...(r.extensions ? { extensions: r.extensions } : {}),
            agentVersion: r.agentVersion,
            profileId: r.profile._id,
            profileVersionId: r.profileVersion.ref ?? r.profileVersion._id,
            ...(persistedVariationGates ? { gates: persistedVariationGates } : {}),
            submissionId,
            ...agentsMdFields,
            run: { _id: runId, attemptNumber: 1, status: "pending", logsUrl: ctx.blobStorage.getLogsBlobUrl(`${requestId}/runs/${runId}/run.jsonl`) },
          };
          newDocs.push(requestDoc);
        }
        variationResults.push({
          profileId: r.profile._id,
          label: r.entry.label,
          ids: newIds,
        });
      }

      await ctx.requestCollection.insertMany(newDocs);

      res.status(201).json({
        ids: allNewIds,
        count: allNewIds.length,
        submissionId,
        variations: variationResults,
        variationCount: variationEntries.length,
        status: "pending",
        mode,
        message: `${allNewIds.length} request(s) submitted across ${variationResults.length} profile(s)`,
        scenario,
        ...(maxIterations ? { maxIterations } : {}),
        ...(persistedVariationGates ? { gates: persistedVariationGates.length } : {}),
      });
      return;
    }

    // --- Profile resolution: if profileId is provided, resolve the version and use its values ---
    let profileId: string | undefined;
    let profileVersionId: string | undefined;
    let profileVersion: ProfileVersionDocument | null = null;
    let resolvedResources: ResourceBinding[] | undefined;
    if (requestedProfileSpec) {
      let requestedProfileId: string;
      let requestedProfileVersion: number | undefined;
      try {
        const parsed = parseProfileSpec(requestedProfileSpec);
        requestedProfileId = parsed.profileId;
        requestedProfileVersion = parsed.version;
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
      const profile = await ctx.profileCollection.findOne({
        _id: requestedProfileId,
        deletedAt: { $exists: false },
      });
      if (!profile) {
        res.status(404).json({ error: `Profile not found: ${requestedProfileId}` });
        return;
      }
      profileVersion = await ctx.profileVersionCollection.findOne({
        profileId: profile._id,
        version: requestedProfileVersion ?? profile.latestVersion,
      });
      if (!profileVersion) {
        res.status(404).json({
          error: `Profile version not found for profile: ${requestedProfileId}`,
          requestedVersion: requestedProfileVersion ?? profile.latestVersion,
        });
        return;
      }
      profileId = profile._id;
      profileVersionId = profileVersion.ref ?? profileVersion._id;

      // Reject requests where client-supplied fields conflict with profile values.
      // Clients should either omit these fields or send values that match the profile.
      const conflicts: string[] = [];
      if (worker && worker !== profileVersion.workerType) {
        conflicts.push(`worker: sent "${worker}", profile requires "${profileVersion.workerType}"`);
      }
      if (requestedModel && requestedModel !== profileVersion.model) {
        conflicts.push(`model: sent "${requestedModel}", profile requires "${profileVersion.model}"`);
      }
      if (mcpServerSlugs !== undefined) {
        const profileMcp = profileVersion.mcpServers ?? [];
        if (JSON.stringify([...mcpServerSlugs].sort()) !== JSON.stringify([...profileMcp].sort())) {
          conflicts.push(`mcpServers: sent ${JSON.stringify(mcpServerSlugs)}, profile requires ${JSON.stringify(profileMcp)}`);
        }
      }
      if (skillSlugs !== undefined) {
        const profileSkills = profileVersion.skillRevisions ?? [];
        if (JSON.stringify([...skillSlugs].sort()) !== JSON.stringify([...profileSkills].sort())) {
          conflicts.push(`skills: sent ${JSON.stringify(skillSlugs)}, profile requires ${JSON.stringify(profileSkills)}`);
        }
      }
      if (extensionIds !== undefined) {
        const profileExts = profileVersion.extensions ?? [];
        if (JSON.stringify([...extensionIds].sort()) !== JSON.stringify([...profileExts].sort())) {
          conflicts.push(`extensions: sent ${JSON.stringify(extensionIds)}, profile requires ${JSON.stringify(profileExts)}`);
        }
      }
      const resourceResult = await resolveResourceBindings(
        ctx,
        projectId,
        requestedResourceSpecs,
        normalizeResourceBindingSpecs(profileVersion.resources),
      );
      if (resourceResult.errors.length > 0) {
        res.status(400).json({ error: resourceResult.errors.join("; "), errors: resourceResult.errors });
        return;
      }
      conflicts.push(...resourceResult.conflicts);
      resolvedResources = resourceResult.bindings;
      if (conflicts.length > 0) {
        res.status(400).json({
          error: `Profile "${profileId}" controls these fields. Either omit them or match the profile values.`,
          conflicts,
        });
        return;
      }

      // Profile fields take precedence
      worker = profileVersion.workerType;
    } else {
      const resourceResult = await resolveResourceBindings(ctx, projectId, requestedResourceSpecs, undefined);
      if (resourceResult.errors.length > 0) {
        res.status(400).json({ error: resourceResult.errors.join("; "), errors: resourceResult.errors });
        return;
      }
      resolvedResources = resourceResult.bindings;
    }

    // Effective values: profile overrides client inputs for controlled fields
    const effectiveModel = profileVersion ? profileVersion.model : requestedModel;
    const effectiveReasoningEffort = profileVersion?.reasoningEffort ? profileVersion.reasoningEffort : requestedReasoningEffort;
    const effectiveMcpServers = profileVersion ? (profileVersion.mcpServers ?? undefined) : mcpServerSlugs;
    const effectiveSkills = profileVersion ? (profileVersion.skillRevisions ?? undefined) : skillSlugs;
    const effectiveExtensions = profileVersion ? (profileVersion.extensions ?? undefined) : extensionIds;

    if (!scenarioObj || typeof scenarioObj !== "object" || !scenarioObj.task || typeof scenarioObj.task !== "string") {
      res.status(400).json({ error: "scenario.task is required and must be a string" });
      return;
    }

    if (!worker) {
      res.status(400).json({ 
        error: "Worker query parameter is required",
        example: "/api/v1/requests?worker=worker-1"
      });
      return;
    }

    // Validate scenario.criteria if provided
    if (scenarioObj.criteria !== undefined) {
      if (!Array.isArray(scenarioObj.criteria) || !scenarioObj.criteria.every((c: unknown) => typeof c === "string")) {
        res.status(400).json({ error: "scenario.criteria must be an array of strings" });
        return;
      }
    }

    // At least one criterion is required — unless maxIterations is explicitly 1
    // (single-iteration mode allows running the agent without judge evaluation)
    const effectiveMaxIter = maxIterations ?? MULTI_TURN_DEFAULTS.MAX_ITERATIONS;
    if (effectiveMaxIter !== 1) {
      if (!scenarioObj.criteria || !Array.isArray(scenarioObj.criteria) || scenarioObj.criteria.length === 0) {
        res.status(400).json({ error: "At least one criterion is required in scenario.criteria when maxIterations > 1" });
        return;
      }
    }

    // Validate maxIterations if provided
    if (maxIterations !== undefined) {
      if (typeof maxIterations !== "number" || maxIterations < 1 || maxIterations > 50) {
        res.status(400).json({ error: "maxIterations must be a number between 1 and 50" });
        return;
      }
    }

    // Validate the per-gate configuration if provided (docs/design/gates.md §4.3).
    // Free-text gate prompts are materialized into typed prompt entities first so
    // validation and persistence both see resolved `promptId`s.
    const gatesProvided = Array.isArray(requestedGates) && requestedGates.length > 0;
    let resolvedGates: GateConfig[] = gatesProvided ? (requestedGates as GateConfig[]) : [];
    if (gatesProvided) {
      resolvedGates = await resolveGatePromptText(ctx, resolvedGates, projectId);
      const gateError = await validateGatesForSubmit(ctx, resolvedGates, maxIterations, projectId);
      if (gateError) {
        res.status(400).json({ error: gateError });
        return;
      }
    }

    // Validate count if provided
    if (typeof count !== "number" || count < 1 || count > 10) {
      res.status(400).json({ error: "count must be a number between 1 and 10" });
      return;
    }

    const workerType = worker as WorkerType;
    const targetCheck = await validateAgentTarget(ctx.agentCollection, {
      workerType,
      requestedVersion: profileVersion?.agentVersion ?? requestedAgentVersion,
      model: effectiveModel,
      requirements: requestedAgentCapabilities({
        reasoningEffort: effectiveReasoningEffort,
        mcpServers: effectiveMcpServers,
        skillRevisions: effectiveSkills,
        extensions: effectiveExtensions,
        resources: resolvedResources,
      }),
      strictCapabilities: ctx.strictAgentCapabilities,
    });
    if (!targetCheck.ok) {
      const { ok: _ok, status, ...payload } = targetCheck;
      res.status(status).json(payload);
      return;
    }
    const agentDoc = targetCheck.agent;
    const model = targetCheck.model;
    const resolvedAgentVersion = targetCheck.agentVersion;

    // Validate reasoning effort against model capabilities
    const warnings: string[] = [];
    let modelCapabilities: { reasoningEffort?: string[] } | undefined;
    if (model) {
      const compoundModelId = `${workerType}:${model}`;
      const modelDoc = await ctx.modelCollection.findOne({ _id: compoundModelId });

      // Preflight: warn (or reject) if the model has disappeared from the provider
      if (modelDoc?.disappearedAt) {
        const MS_PER_DAY = 86_400_000;
        const daysSinceDisappeared = Math.floor(
          (Date.now() - new Date(modelDoc.disappearedAt).getTime()) / MS_PER_DAY
        );
        if (daysSinceDisappeared >= 1) {
          // Model has been gone for over 24 hours — hard reject
          res.status(400).json({
            error: `Model "${model}" is no longer available for agent "${workerType}"`,
            errorCode: "model_unavailable_for_worker",
            disappearedAt: modelDoc.disappearedAt,
            lastSeenAt: modelDoc.lastSeenAt,
            supportedModels: agentDoc?.supportedModels?.filter(m => m !== model),
          });
          return;
        }
        // Disappeared recently — warn but allow (scanner lag / transient)
        warnings.push(
          `Model "${model}" was last seen at ${modelDoc.lastSeenAt.toISOString()} and ` +
          `disappeared at ${modelDoc.disappearedAt.toISOString()}. It may not be available at runtime.`
        );
      }

      if (modelDoc?.capabilities) {
        modelCapabilities = modelDoc.capabilities;
        const supportedEfforts = modelDoc.capabilities.reasoningEffort;
        if (supportedEfforts && supportedEfforts.length > 0) {
          if (effectiveReasoningEffort) {
            if (!supportedEfforts.includes(effectiveReasoningEffort)) {
              res.status(400).json({
                error: `Reasoning effort "${effectiveReasoningEffort}" is not supported by model "${model}"`,
                supportedReasoningEfforts: supportedEfforts,
              });
              return;
            }
          } else if (supportedEfforts.length === 1) {
            warnings.push(
              `Model "${model}" only supports reasoning effort "${supportedEfforts[0]}". The agent extension may send an incompatible effort level.`
            );
          } else if (supportedEfforts.length < 4) {
            warnings.push(
              `Model "${model}" supports limited reasoning efforts: ${supportedEfforts.join(", ")}. The agent extension may send an incompatible effort level.`
            );
          }
        }
      }
    }

    // Warn if reasoning effort is requested but the worker doesn't support it
    if (effectiveReasoningEffort && agentDoc && !agentDoc.capabilities?.supportsReasoningEffort) {
      warnings.push(
        `Worker "${workerType}" does not declare support for reasoning effort. The effort setting "${effectiveReasoningEffort}" may be ignored.`
      );
    }

    // Validate MCP server slugs if provided
    let validatedMcpServers: string[] | undefined;
    if (effectiveMcpServers !== undefined) {
      if (!Array.isArray(effectiveMcpServers) || !effectiveMcpServers.every((s: unknown) => typeof s === "string")) {
        res.status(400).json({ error: "mcpServers must be an array of strings (MCP server slugs)" });
        return;
      }
      if (effectiveMcpServers.length > 0) {
        const existingServers = await ctx.mcpServerCollection
          .find({
            projectId,
            $or: [{ slug: { $in: effectiveMcpServers } }, { _id: { $in: effectiveMcpServers } }],
            deletedAt: { $exists: false },
          })
          .toArray();
        const existingSlugs = new Set(existingServers.map((s: McpServerDocument) => s.slug ?? s._id));
        const missingSlugs = effectiveMcpServers.filter((slug: string) => !existingSlugs.has(slug));
        if (missingSlugs.length > 0) {
          res.status(400).json({ error: `MCP server(s) not found: ${missingSlugs.join(", ")}` });
          return;
        }
        validatedMcpServers = effectiveMcpServers;
      }
    }

    // Validate and resolve skill slugs if provided
    let resolvedSkillRevisions: string[] | undefined;
    if (effectiveSkills !== undefined) {
      if (!Array.isArray(effectiveSkills) || !effectiveSkills.every((s: unknown) => typeof s === "string")) {
        res.status(400).json({ error: "skills must be an array of strings (skill slugs)" });
        return;
      }
      if (effectiveSkills.length > 0) {
        const result = await resolveSkillSpecs(effectiveSkills, ctx, projectId);
        if (result.error) {
          const status = result.error.startsWith("Failed to resolve") ? 422 : 400;
          res.status(status).json({ error: result.error });
          return;
        }
        resolvedSkillRevisions = result.refs;
      }
    }

    // Validate extension specs if provided (supports "id" or "id@version" format)
    let validatedExtensions: string[] | undefined;
    if (effectiveExtensions !== undefined) {
      if (!Array.isArray(effectiveExtensions) || !effectiveExtensions.every((s: unknown) => typeof s === "string")) {
        res.status(400).json({ error: "extensions must be an array of strings (extension IDs or id@version specs)" });
        return;
      }
      if (effectiveExtensions.length > 0) {
        // Parse specs to extract bare IDs for DB validation
        const parsedSpecs = effectiveExtensions.map((spec: string) => parseExtensionSpec(spec));
        const bareIds = parsedSpecs.map((s) => s.id);
        const missingIds = await findMissingExtensionSlugs(bareIds, ctx.extensionCollection, projectId);
        if (missingIds.length > 0) {
          res.status(400).json({ error: `Extension(s) not found: ${missingIds.join(", ")}` });
          return;
        }

        // Resolve "latest stable" for extensions without a pinned version
        const extensionClient = new ExtensionClient("");
        const resolvedSpecs: string[] = [];
        for (const spec of parsedSpecs) {
          if (spec.version) {
            // Version already pinned
            resolvedSpecs.push(`${spec.id}@${spec.version}`);
          } else {
            // Resolve latest stable from marketplace
            const versions = await extensionClient.getVersions(spec.id, false);
            if (versions.length === 0) {
              res.status(422).json({ error: `No stable versions found for extension "${spec.id}"` });
              return;
            }
            resolvedSpecs.push(`${spec.id}@${versions[0].version}`);
          }
        }
        validatedExtensions = resolvedSpecs;
      }
    }

    // Normalize scenario: ensure criteria is always an array, preserve version
    const scenario: RequestDocument['scenario'] = {
      task: scenarioObj.task as string,
      criteria: Array.isArray(scenarioObj.criteria) ? scenarioObj.criteria as string[] : [],
      ...(scenarioObj.version === 'v1' || scenarioObj.version === 'v2' ? { version: scenarioObj.version } : {}),
    };

    const mode = scenario.criteria.length > 0 ? "multi-turn" : "one-shot";

    // Ensure a TaskPrompt entity exists for this task text (idempotent)
    const taskPrompt = await ctx.taskPromptStore.findOrCreate(projectId, scenario.task);
    const taskPromptId = taskPrompt._id;

    // Resolve AGENTS.md lineage once for this submission (shared across count>1).
    const agentsMdPromptId = await resolveAgentsMdPromptId();
    const agentsMdFields = buildAgentsMdFields(agentsMdPromptId);

    // Build the persisted gate configs: order canonically and point the Select
    // gate's prompt at the resolved task prompt (docs/design/gates.md §4.3).
    const persistedGates: GateConfig[] | undefined = gatesProvided
      ? orderGates(resolvedGates).map((g) =>
          g.gate === "select" ? { ...g, promptId: taskPromptId } : g,
        )
      : undefined;

    // Generate a submission ID to group all runs from this request
    const submissionId = uuidv4();

    // Handle multiple runs (count > 1)
    if (count > 1) {
      const newIds: string[] = [];
      const newDocs: RequestDocument[] = [];

      for (let i = 0; i < count; i++) {
        const requestId = uuidv4();
        const runId = uuidv4();
        newIds.push(requestId);

        const requestDoc: RequestDocument = {
          _id: requestId,
          projectId,
          scenario,
          workerType,
          taskPromptId,
          createdAt: new Date(),
          priority: requestedPriority ?? 0,
          ...(model ? { model } : {}),
          ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
          ...(maxIterations ? { maxIterations } : {}),
          ...(personaInstructions ? { personaInstructions } : {}),
          ...(personaObj ? { persona: personaObj } : {}),
          ...(validatedMcpServers ? { mcpServers: validatedMcpServers } : {}),
          ...(resolvedSkillRevisions ? { skillRevisions: resolvedSkillRevisions } : {}),
          ...(resolvedCodebaseRevisionId ? { codebaseRevisionId: resolvedCodebaseRevisionId } : {}),
          ...(resolvedResources ? { resources: resolvedResources } : {}),
          ...(validatedExtensions ? { extensions: validatedExtensions } : {}),
          agentVersion: resolvedAgentVersion,
          ...(profileId ? { profileId } : {}),
          ...(profileVersionId ? { profileVersionId } : {}),
          ...(persistedGates ? { gates: persistedGates } : {}),
          submissionId,
          ...agentsMdFields,
          // Mint a distinct run id for the first attempt. Blob artifacts
          // are scoped under `{requestId}/runs/{runId}/...` so retries
          // never overwrite a previous attempt's blobs.
          run: { _id: runId, attemptNumber: 1, status: "pending", logsUrl: ctx.blobStorage.getLogsBlobUrl(`${requestId}/runs/${runId}/run.jsonl`) },
        };
        newDocs.push(requestDoc);
      }

      // Bulk insert all documents — scheduler will dispatch to queues
      await ctx.requestCollection.insertMany(newDocs);

      console.log(`Created ${count} ${mode} requests for ${workerType} (priority: ${requestedPriority ?? 0})`);

      res.status(201).json({
        ids: newIds,
        count,
        submissionId,
        workerType,
        taskPromptId,
        ...(model ? { model } : {}),
        ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
        agentVersion: resolvedAgentVersion,
        status: "pending",
        mode,
        message: `${count} requests submitted successfully`,
        scenario,
        ...(maxIterations ? { maxIterations } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(modelCapabilities ? { modelCapabilities } : {}),
      });
      return;
    }

    // Single run (count === 1) - original behavior
    const requestId = uuidv4();
    const runId = uuidv4();

    // Create request document
    const requestDoc: RequestDocument = {
      _id: requestId,
      projectId,
      scenario,
      workerType,
      taskPromptId,
      createdAt: new Date(),
      priority: requestedPriority ?? 0,
      ...(model ? { model } : {}),
      ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
      ...(maxIterations ? { maxIterations } : {}),
      ...(personaInstructions ? { personaInstructions } : {}),
      ...(personaObj ? { persona: personaObj } : {}),
      ...(validatedMcpServers ? { mcpServers: validatedMcpServers } : {}),
      ...(resolvedSkillRevisions ? { skillRevisions: resolvedSkillRevisions } : {}),
      ...(resolvedCodebaseRevisionId ? { codebaseRevisionId: resolvedCodebaseRevisionId } : {}),
      ...(resolvedResources ? { resources: resolvedResources } : {}),
      ...(validatedExtensions ? { extensions: validatedExtensions } : {}),
      ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
      ...(profileId ? { profileId } : {}),
      ...(profileVersionId ? { profileVersionId } : {}),
      ...(persistedGates ? { gates: persistedGates } : {}),
      submissionId,
      ...agentsMdFields,
      // Mint a distinct run id for the first attempt. Blob artifacts
      // are scoped under `{requestId}/runs/{runId}/...` so retries
      // never overwrite a previous attempt's blobs.
      run: { _id: runId, attemptNumber: 1, status: "pending", logsUrl: ctx.blobStorage.getLogsBlobUrl(`${requestId}/runs/${runId}/run.jsonl`) },
    };

    // Store in MongoDB — scheduler will dispatch to queue
    await ctx.requestCollection.insertOne(requestDoc);

    console.log(`Created ${mode} request ${requestId} for ${workerType} (priority: ${requestedPriority ?? 0})`);

    res.status(201).json({
      id: requestId,
      submissionId,
      workerType,
      ...(model ? { model } : {}),
      ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
      ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
      status: requestDoc.run?.status ?? "pending",
      mode,
      message: "Request submitted successfully",
      scenario,
      ...(maxIterations ? { maxIterations } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(modelCapabilities ? { modelCapabilities } : {}),
    });
  },
});

// List run filter facets for the Runs list rail.
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/facets",
  tags: ["Requests"],
  summary: "List run filter facets",
  description:
    "Returns every distinct value and its full-dataset count per categorical " +
    "filter dimension for the Runs list rail. Counts are absolute over all " +
    "non-deleted runs **in the given project**: they intentionally ignore the " +
    "active search, date range, iteration, and categorical selections so every " +
    "selectable value stays visible with a stable count. Requires ?projectId=. " +
    "Computed with parallel $group aggregations (Cosmos has no $facet) and cached " +
    "per-project for a short TTL.",
  query: ProjectIdQuerySchema,
  response: RunFacetsResponseSchema,
  handler: async (req, res) => {
    res.json(await getRunFacets(ctx.requestCollection, getQueryProjectId(req)));
  },
});

// Get request status
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id",
  tags: ["Requests"],
  summary: "Get request",
  params: z.object({ id: z.string() }),
  response: RequestResponseSchema,
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id } = req.params;

    const resource = await ctx.requestCollection.findOne({ _id: id });

    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    // Enrich `processing` runs with the latest liveness heartbeat from
    // Redis. (Heartbeats are stored in Redis — not Mongo — to avoid the
    // CosmosDB RU cost of a sub-document write every 15s per active run.)
    if (resource.run?.status === "processing" && resource.run._id) {
      const hb = await ctx.heartbeatStore.get(resource.run._id);
      if (hb) resource.run.lastHeartbeatAt = hb;
    }

    // Map _id back to id for API response
    res.json({ ...resource, id: resource._id });
  },
});

// List all requests (excludes soft-deleted by default)
// When groupBy is provided, returns paginated RunGroup[]; otherwise paginated runs.
// Uses cursor-based pagination with `after`/`before` params.
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests",
  tags: ["Requests"],
  summary: "List requests",
  query: ListRequestsQuerySchema.merge(ProjectIdQuerySchema),
  response: z.union([PaginatedRunsResponseSchema, PaginatedRunGroupsResponseSchema]),
  handler: async (req, res) => {
    const projectId = getQueryProjectId(req);
    const taskPromptIdFilter = req.query.taskPromptId as string;
    const criteriaFilter = req.query.criteria as string;
    const submissionIdFilter = req.query.submissionId as string;
    const searchFilter = req.query.search as string | undefined;
    const turnsFilterRaw = req.query.turns as string | undefined;
    const turnsOpFilter = (req.query.turnsOp as string | undefined) ?? "eq";
    const maxIterationsFilterRaw = req.query.maxIterations as string | undefined;
    const maxIterationsOpFilter = (req.query.maxIterationsOp as string | undefined) ?? "eq";
    const includeDeleted = req.query.includeDeleted === "true";
    const groupByParam = req.query.groupBy as "task" | "submissionId" | "profile" | undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
    const afterParam = req.query.after as string | undefined;
    const beforeParam = req.query.before as string | undefined;
    const lastParam = req.query.last === "true";

    // Multi-value categorical filters: accept a single value, a repeated param,
    // or a comma list, plus the `__empty__` "(Unknown)" sentinel (issue #1138).
    const workerValues = parseMulti(req.query.worker);
    const statusValues = parseMulti(req.query.status);
    const outcomeValues = parseMulti(req.query.outcome);
    const profileIdValues = parseMulti(req.query.profileId);
    const modelValues = parseMulti(req.query.model);
    const osValues = parseMulti(req.query.os);
    const priorityValues = parseMulti(req.query.priority);
    const agentVersionValues = parseMulti(req.query.agentVersion);

    // Server-side sort: map sortBy → indexable stored field. The unset default
    // stays `createdAt desc` so existing in-flight cursors keep working.
    const sortField = resolveSortField(req.query.sortBy as string | undefined);
    const sortDir: 1 | -1 = (req.query.sortDir as string | undefined) === "asc" ? 1 : -1;

    // Created-at date/time range (ISO-8601). Adopted from PR #908.
    const createdAfterRaw = req.query.createdAfter as string | Date | undefined;
    const createdBeforeRaw = req.query.createdBefore as string | Date | undefined;

    if (afterParam && beforeParam) {
      res.status(400).json({ error: "Cannot specify both 'after' and 'before'" });
      return;
    }
    if (lastParam && (afterParam || beforeParam)) {
      res.status(400).json({ error: "Cannot combine 'last=true' with 'after' or 'before'" });
      return;
    }
    
    // ── Build the filter ───────────────────────────────────────────────────
    // Simple single-field clauses stay top-level (index-friendly, and Cosmos
    // intersects single-field indexes). Clauses that are `$or` groups
    // (multi-value-with-(Unknown), free-text search) or that repeat a field
    // (criteria) go into `$and` so they compose without clobbering each other
    // or the cursor seek (issue #1138).
    const flat: Record<string, unknown> = {};
    const and: Record<string, unknown>[] = [];
    // Required project scope: the top-level runs list only ever returns rows
    // from the selected project (no cross-project reads, no groupBy:project).
    flat.projectId = projectId;
    const pushClause = (clause: Record<string, unknown> | null) => {
      if (!clause) return;
      const keys = Object.keys(clause);
      if (keys.length === 1 && !keys[0].startsWith("$")) {
        flat[keys[0]] = clause[keys[0]];
      } else {
        and.push(clause);
      }
    };

    pushClause(buildMultiClause("workerType", workerValues));
    if (taskPromptIdFilter) flat.taskPromptId = taskPromptIdFilter;
    // Post run-retry-attempts: per-attempt state lives at run.status / run.outcome.
    pushClause(buildMultiClause("run.status", statusValues));
    pushClause(buildMultiClause("run.outcome", outcomeValues));
    pushClause(buildMultiClause("profileId", profileIdValues));
    pushClause(buildMultiClause("model", modelValues));
    pushClause(buildMultiClause("run.os.platform", osValues));
    pushClause(buildMultiClause("priority", priorityValues, { coerceNumber: true }));
    pushClause(buildMultiClause("agentVersion", agentVersionValues));

    if (submissionIdFilter) {
      // Prefix-based matching: allow filtering by partial submission ID.
      flat.submissionId = { $regex: `^${submissionIdFilter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` };
    }
    if (!includeDeleted) {
      flat.deletedAt = { $exists: false };
    }

    // Free-text search across run id / task / model / worker (Cosmos has no $text).
    pushClause(buildSearchClause(searchFilter));

    // Created-at date/time range (PR #908).
    const createdAfter = createdAfterRaw
      ? (createdAfterRaw instanceof Date ? createdAfterRaw : new Date(createdAfterRaw))
      : undefined;
    const createdBefore = createdBeforeRaw
      ? (createdBeforeRaw instanceof Date ? createdBeforeRaw : new Date(createdBeforeRaw))
      : undefined;
    if ((createdAfter && Number.isNaN(createdAfter.getTime())) || (createdBefore && Number.isNaN(createdBefore.getTime()))) {
      res.status(400).json({ error: "Invalid createdAfter or createdBefore datetime" });
      return;
    }
    if (createdAfter && createdBefore && createdAfter > createdBefore) {
      res.status(400).json({ error: "createdAfter must be less than or equal to createdBefore" });
      return;
    }
    if (createdAfter || createdBefore) {
      flat.createdAt = {
        ...(createdAfter ? { $gte: createdAfter } : {}),
        ...(createdBefore ? { $lte: createdBefore } : {}),
      };
    }

    // Iteration-count filters. `maxIterations` is a top-level field; `turns`
    // requires a $expr against the size of the run.turns array.
    const OP_MAP: Record<string, "$eq" | "$gte" | "$lte"> = { eq: "$eq", gte: "$gte", lte: "$lte" };
    if (maxIterationsFilterRaw !== undefined && maxIterationsFilterRaw !== "") {
      const n = Number(maxIterationsFilterRaw);
      const op = OP_MAP[maxIterationsOpFilter];
      if (!Number.isFinite(n) || n < 0 || !op) {
        res.status(400).json({ error: "Invalid maxIterations or maxIterationsOp" });
        return;
      }
      flat.maxIterations = { [op]: n };
    }
    if (turnsFilterRaw !== undefined && turnsFilterRaw !== "") {
      const n = Number(turnsFilterRaw);
      const op = OP_MAP[turnsOpFilter];
      if (!Number.isFinite(n) || n < 0 || !op) {
        res.status(400).json({ error: "Invalid turns or turnsOp" });
        return;
      }
      flat.$expr = { [op]: [{ $size: { $ifNull: ["$run.turns", []] } }, n] };
    }

    // Filter by MDP criteria state vector (e.g. "has_azure:0|has_cloud:1").
    // Matches runs whose LAST turn contains criteria results matching every
    // criterion in the state vector.
    if (criteriaFilter) {
      const criteriaStates = parseStateKey(criteriaFilter);
      for (const cs of criteriaStates) {
        and.push({
          turns: {
            $elemMatch: {
              criteriaResults: { $elemMatch: { criterionId: cs.id, passed: cs.passed } },
            },
          },
        });
      }
    }

    /** Assemble the final filter; `seek` (cursor predicate) is AND-ed in. */
    const composeFilter = (seek?: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = { ...flat };
      const clauses = seek ? [...and, seek] : and;
      if (clauses.length > 0) out.$and = clauses;
      return out;
    };

    const filter: Record<string, unknown> = composeFilter();

    // Total shown by the portal pager / "~N runs total" banner — flat mode only.
    // Grouped mode is measured in *groups*, not runs, and the pager is driven
    // purely by the group cursors below, so we return no run-count total for it
    // (this also skips a countDocuments/estimatedDocumentCount call per grouped
    // request). For flat mode: when a filter is active, return an accurate
    // `countDocuments(filter)` so the page count and total reflect the filtered
    // dataset, not the whole collection; otherwise use the O(1)
    // collection-metadata estimate (issue #1138).
    const hasActiveFilter =
      and.length > 0 || Object.keys(flat).some((k) => k !== "deletedAt");
    const estimatedTotal = groupByParam
      ? undefined
      : hasActiveFilter
        ? await ctx.requestCollection.countDocuments(filter)
        : await ctx.requestCollection.estimatedDocumentCount();

    // Grouped mode: paginated RunGroup[] via two-phase aggregation
    if (groupByParam) {
      const groupByField = groupByParam === "task" ? "taskPromptId" : groupByParam === "profile" ? "profileId" : "submissionId";
      const groupByAggField = `$${groupByField}`;

      // Decode group cursor
      let afterKey: string | undefined;
      let beforeKey: string | undefined;
      if (afterParam) {
        try {
          const parsed = decodeCursor(afterParam);
          if (!(groupByField in parsed)) { res.status(400).json({ error: `Invalid cursor: expected '${groupByField}' field` }); return; }
          afterKey = parsed[groupByField];
        } catch { res.status(400).json({ error: "Invalid cursor" }); return; }
      }
      if (beforeParam) {
        try {
          const parsed = decodeCursor(beforeParam);
          if (!(groupByField in parsed)) { res.status(400).json({ error: `Invalid cursor: expected '${groupByField}' field` }); return; }
          beforeKey = parsed[groupByField];
        } catch { res.status(400).json({ error: "Invalid cursor" }); return; }
      }

      // Phase 1: Get paginated distinct group keys + total count (lightweight)
      // For "last" and backward pagination we sort descending and later reverse the
      // results; forward pagination (and the default first page) sorts ascending.
      const sortDescending = lastParam || beforeKey !== undefined;
      const keyPipeline: Record<string, unknown>[] = [
        { $match: filter },
        { $group: { _id: groupByAggField } },
        { $sort: { _id: sortDescending ? -1 : 1 } },
      ];
      if (!lastParam && afterKey !== undefined) {
        keyPipeline.push({ $match: { _id: { $gt: afterKey } } });
      }
      if (!lastParam && beforeKey !== undefined) {
        keyPipeline.push({ $match: { _id: { $lt: beforeKey } } });
      }
      keyPipeline.push({ $limit: limit });

      const keyResults = await ctx.requestCollection.aggregate(keyPipeline).toArray();

      // Reverse results for backward pagination
      if (lastParam || beforeKey !== undefined) {
        keyResults.reverse();
      }

      const pageKeys: string[] = keyResults.map((k) => k._id as string);

      if (pageKeys.length === 0) {
        res.json({ data: [], limit, estimatedTotal, cursors: { next: null, prev: null } });
        return;
      }

      // Phase 2: Full aggregation scoped to current page's groups only
      const phase2Pipeline = [
        { $match: { ...filter, [groupByField]: { $in: pageKeys } } },
        ...buildGroupingPipeline(groupByParam),
      ];
      const groups = await ctx.requestCollection.aggregate(phase2Pipeline).toArray();

      // Build cursors
      const firstKey = pageKeys[0];
      const lastKey = pageKeys[pageKeys.length - 1];

      // Check if there are more results in each direction
      const [hasMoreAfter, hasMoreBefore] = lastParam
        ? await Promise.all([
            Promise.resolve([] as Record<string, unknown>[]),
            ctx.requestCollection.aggregate([
              { $match: filter },
              { $group: { _id: groupByAggField } },
              { $sort: { _id: 1 } },
              { $match: { _id: { $lt: firstKey } } },
              { $limit: 1 },
            ]).toArray(),
          ])
        : await Promise.all([
            ctx.requestCollection.aggregate([
              { $match: filter },
              { $group: { _id: groupByAggField } },
              { $sort: { _id: 1 } },
              { $match: { _id: { $gt: lastKey } } },
              { $limit: 1 },
            ]).toArray(),
            ctx.requestCollection.aggregate([
              { $match: filter },
              { $group: { _id: groupByAggField } },
              { $sort: { _id: 1 } },
              { $match: { _id: { $lt: firstKey } } },
              { $limit: 1 },
            ]).toArray(),
          ]);

      res.json({
        data: groups,
        limit,
        estimatedTotal,
        cursors: {
          next: lastParam ? null : hasMoreAfter.length > 0 ? encodeCursor({ [groupByField]: lastKey }) : null,
          prev: hasMoreBefore.length > 0 ? encodeCursor({ [groupByField]: firstKey }) : null,
        },
      });
      return;
    }

    // Flat mode: paginated runs with a cursor seek on { <sortField>, _id }.
    // `sortField`/`sortDir` are resolved above; the default is createdAt desc.
    let afterCursor: Record<string, string> | undefined;
    let beforeCursor: Record<string, string> | undefined;
    if (afterParam) {
      try {
        afterCursor = decodeCursor(afterParam);
      } catch { res.status(400).json({ error: "Invalid cursor" }); return; }
    }
    if (beforeParam) {
      try {
        beforeCursor = decodeCursor(beforeParam);
      } catch { res.status(400).json({ error: "Invalid cursor" }); return; }
    }

    const forwardSort = buildSortObject(sortField, sortDir);              // display order
    const reverseSort = buildSortObject(sortField, (-sortDir) as 1 | -1); // flipped

    let queryFilter: Record<string, unknown>;
    let sort: Record<string, 1 | -1>;
    let needsReverse = false;

    if (lastParam) {
      // Jump to the last page: query in reverse, then flip back to display order.
      sort = reverseSort;
      needsReverse = true;
      queryFilter = composeFilter();
    } else if (afterCursor) {
      // Forward: items after this cursor in display order.
      sort = forwardSort;
      const cval = deserializeSortValue(sortField, afterCursor[sortField]);
      queryFilter = composeFilter(buildSeek(sortField, sortDir, cval, afterCursor.id ?? ""));
    } else if (beforeCursor) {
      // Backward: seek in reverse, then flip back to display order.
      sort = reverseSort;
      needsReverse = true;
      const cval = deserializeSortValue(sortField, beforeCursor[sortField]);
      queryFilter = composeFilter(buildSeek(sortField, (-sortDir) as 1 | -1, cval, beforeCursor.id ?? ""));
    } else {
      sort = forwardSort;
      queryFilter = composeFilter();
    }

    const resources = await ctx.requestCollection.find(queryFilter).sort(sort).limit(limit).toArray();

    if (needsReverse) {
      resources.reverse();
    }

    const data = resources.map((r) => ({ ...r, id: r._id }));

    // Enrich `processing` runs with the latest liveness heartbeat from
    // Redis. The store's mget is cluster-safe (a pipeline of single-key GETs,
    // not a cross-slot MGET) so this works on clustered Redis too — see
    // clusterSafeMget / issue #1064. Heartbeats live in Redis, not Mongo.
    const processingRunIds = data
      .filter((r) => r.run?.status === "processing" && r.run._id)
      .map((r) => r.run!._id!);
    if (processingRunIds.length > 0) {
      const hbMap = await ctx.heartbeatStore.mget(processingRunIds);
      for (const r of data) {
        const runId = r.run?._id;
        if (runId && hbMap.has(runId)) {
          r.run!.lastHeartbeatAt = hbMap.get(runId);
        }
      }
    }

    if (data.length === 0) {
      res.json({ data: [], limit, estimatedTotal, cursors: { next: null, prev: null } });
      return;
    }

    // Build cursors from first and last items, keyed by the active sort field.
    const first = data[0];
    const last = data[data.length - 1];
    const firstSortRaw = sortValueOf(first, sortField);
    const lastSortRaw = sortValueOf(last, sortField);
    const firstSortVal = serializeSortValue(sortField, firstSortRaw);
    const lastSortVal = serializeSortValue(sortField, lastSortRaw);
    const firstId = String(first._id);
    const lastId = String(last._id);

    // Existence probes: anything after `last` (forward) / before `first` (backward).
    const afterProbe = composeFilter(buildSeek(sortField, sortDir, lastSortRaw, lastId));
    const beforeProbe = composeFilter(buildSeek(sortField, (-sortDir) as 1 | -1, firstSortRaw, firstId));
    const [hasMoreAfter, hasMoreBefore] = lastParam
      ? await Promise.all([
          Promise.resolve([] as Record<string, unknown>[]),
          ctx.requestCollection.find(beforeProbe).sort(reverseSort).limit(1).toArray(),
        ])
      : await Promise.all([
          ctx.requestCollection.find(afterProbe).sort(forwardSort).limit(1).toArray(),
          ctx.requestCollection.find(beforeProbe).sort(reverseSort).limit(1).toArray(),
        ]);

    res.json({
      data,
      limit,
      estimatedTotal,
      cursors: {
        next: lastParam ? null : hasMoreAfter.length > 0 ? encodeCursor({ [sortField]: lastSortVal, id: lastId }) : null,
        prev: hasMoreBefore.length > 0 ? encodeCursor({ [sortField]: firstSortVal, id: firstId }) : null,
      },
    });
  },
});

// Cap how many runs a single analysis pass loads into memory. We fetch the
// most-recent-N done runs (sorted by createdAt, served by the existing createdAt
// index from migration 010) rather than the entire collection, so memory stays
// bounded as the run history grows. Override via ANALYSIS_MAX_RUNS. When the cap
// is hit the response sets truncated=true and the portal shows a "most recent N"
// banner instead of silently dropping data or breaking the page.
const ANALYSIS_MAX_RUNS = Math.max(1, Number(process.env.ANALYSIS_MAX_RUNS) || 5000);

// Analysis endpoint - compute pass@k, success@T, and iteration stats
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/analysis",
  tags: ["Requests"],
  summary: "Compute pass@k / success@T metrics",
  description:
    "Aggregates pass@k / success@T metrics over a single project's done runs. Requires ?projectId=.",
  query: z.object({
    worker: z.string().optional(),
    taskPromptId: z.string().optional(),
    criteria: z.string().optional(),
    features: z.string().optional(),
    submissionId: z.string().optional(),
    k: z.string().optional(),
  }).merge(ProjectIdQuerySchema),
  response: z.object({}).passthrough().describe("Analysis metrics"),
  handler: async (req, res) => {
    // Scope every metric to the selected project — no cross-project aggregation
    // (400 when ?projectId= is absent, mirroring the runs list / facets routes).
    const projectId = getQueryProjectId(req);

    // Parse k values from query string (default: 1,2,5)
    const kParam = (req.query.k as string) || "1,2,5";
    const kValues = kParam.split(",").map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v) && v > 0);

    // Parse criteria filter from query string (comma-separated criterion IDs)
    const criteriaParam = req.query.criteria as string | undefined;
    const selectedCriteria = criteriaParam
      ? criteriaParam.split(",").map(c => c.trim()).filter(Boolean)
      : undefined;

    // Parse task-prompt feature filter from query string (comma-separated feature IDs)
    const featuresParam = req.query.features as string | undefined;
    const selectedFeatures = featuresParam
      ? featuresParam.split(",").map(f => f.trim()).filter(Boolean)
      : undefined;

    // Fetch the most-recent done runs (exclude pending/processing and deleted),
    // capped to ANALYSIS_MAX_RUNS to bound memory. Sorted by createdAt desc using
    // the existing createdAt index. The projection is slimmed to only the fields
    // the analysis actually reads: the heavy per-turn payloads (agent transcripts
    // `codingAgentResponse`, `judgeFeedback`, legacy inline `toolCalls`, HAR/video
    // URLs, etc.) are excluded — a single run can otherwise approach Cosmos's 2 MB
    // document limit. Per-attempt state lives at run.* (run-retry-attempts).
    // Fetch one extra (limit + 1) so we can detect "more exist" without a count.
    const runDocs = await ctx.requestCollection
      .find({
        projectId,
        "run.status": "done",
        deletedAt: { $exists: false },
      })
      .project({
        _id: 1,
        scenario: 1,
        workerType: 1,
        taskPromptId: 1,
        "run.status": 1,
        "run.outcome": 1,
        "run.turns.iteration": 1,
        "run.turns.passed": 1,
        "run.turns.durationMs": 1,
        "run.turns.criteriaResults": 1,
      })
      .sort({ createdAt: -1 })
      .limit(ANALYSIS_MAX_RUNS + 1)
      .toArray();

    // Trim back to the cap; `truncated` tells the portal to show a "most recent N"
    // banner so capped metrics are never presented as if they covered everything.
    const { runs, truncated } = capRunsToLimit(runDocs, ANALYSIS_MAX_RUNS);

    // Effective task-prompt id per run: stored taskPromptId, else derived from the
    // task text (legacy runs). Used to join task-prompt features for filtering.
    const effectiveTaskPromptId = (r: { taskPromptId?: string; scenario?: { task?: string } }): string | undefined =>
      r.taskPromptId || (r.scenario?.task ? computeTaskPromptId(r.scenario.task) : undefined);

    // Batch-lookup task prompts for their detected/evaluated features.
    const taskPromptIds = [
      ...new Set(runs.map(r => effectiveTaskPromptId(r)).filter(Boolean)),
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

    // Transform to AnalyzableRun format
    const analyzableRuns: AnalyzableRun[] = runs.map(r => {
      const tpId = effectiveTaskPromptId(r);
      return {
        scenario: r.scenario,
        taskPromptId: tpId,
        promptFeatures: tpId ? taskPromptFeatures.get(tpId) : undefined,
        workerType: r.workerType,
        status: r.run?.status ?? "done",
        outcome: r.run?.outcome,
        turns: r.run?.turns,
      };
    });

    const analysis: AnalysisResponse = computeAnalysis(analyzableRuns, kValues, selectedCriteria, selectedFeatures);
    res.json({ ...analysis, truncated, runLimit: ANALYSIS_MAX_RUNS });
  },
});

// Bulk re-submit requests (create new runs from existing ones)
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/bulk-resubmit",
  tags: ["Requests"],
  summary: "Bulk resubmit requests",
  body: BulkResubmitInputSchema,
  response: z.array(RequestResponseSchema),
  successStatus: 201,
  handler: async (req, res) => {
    const { ids, count, overrides } = req.body;

    // Resolve profile override (once for the entire batch)
    let overrideProfileId: string | null | undefined = overrides?.profileId;
    let overrideProfileVersionId: string | undefined;
    let overrideProfileVersion: ProfileVersionDocument | null = null;
    if (typeof overrideProfileId === "string") {
      const profile = await ctx.profileCollection.findOne({
        _id: overrideProfileId,
        deletedAt: { $exists: false },
      });
      if (!profile) {
        res.status(404).json({ error: `Profile not found: ${overrideProfileId}` });
        return;
      }
      overrideProfileVersion = await ctx.profileVersionCollection.findOne({
        profileId: profile._id,
        version: profile.latestVersion,
      });
      if (!overrideProfileVersion) {
        res.status(404).json({ error: `Profile version not found for profile: ${overrideProfileId}` });
        return;
      }
      overrideProfileVersionId = overrideProfileVersion.ref ?? overrideProfileVersion._id;

      // Reject individual overrides that conflict with the profile's controlled fields
      const conflicts: string[] = [];
      if (overrides?.workerType && overrides.workerType !== overrideProfileVersion.workerType) {
        conflicts.push(`workerType: sent "${overrides.workerType}", profile requires "${overrideProfileVersion.workerType}"`);
      }
      if (overrides?.model !== undefined && overrides.model !== overrideProfileVersion.model) {
        conflicts.push(`model: sent "${overrides.model}", profile requires "${overrideProfileVersion.model}"`);
      }
      if (overrides?.reasoningEffort !== undefined && overrideProfileVersion.reasoningEffort && overrides.reasoningEffort !== overrideProfileVersion.reasoningEffort) {
        conflicts.push(`reasoningEffort: sent "${overrides.reasoningEffort}", profile requires "${overrideProfileVersion.reasoningEffort}"`);
      }
      if (overrides?.mcpServers !== undefined) {
        const profileMcp = overrideProfileVersion.mcpServers ?? [];
        if (JSON.stringify([...overrides.mcpServers!].sort()) !== JSON.stringify([...profileMcp].sort())) {
          conflicts.push(`mcpServers: sent ${JSON.stringify(overrides.mcpServers)}, profile requires ${JSON.stringify(profileMcp)}`);
        }
      }
      if (overrides?.skillRevisions !== undefined) {
        const profileSkills = overrideProfileVersion.skillRevisions ?? [];
        if (JSON.stringify([...overrides.skillRevisions!].sort()) !== JSON.stringify([...profileSkills].sort())) {
          conflicts.push(`skillRevisions: sent ${JSON.stringify(overrides.skillRevisions)}, profile requires ${JSON.stringify(profileSkills)}`);
        }
      }
      if (overrides?.extensions !== undefined) {
        const profileExts = overrideProfileVersion.extensions ?? [];
        if (JSON.stringify([...overrides.extensions!].sort()) !== JSON.stringify([...profileExts].sort())) {
          conflicts.push(`extensions: sent ${JSON.stringify(overrides.extensions)}, profile requires ${JSON.stringify(profileExts)}`);
        }
      }
      if (conflicts.length > 0) {
        res.status(400).json({
          error: `Profile "${overrideProfileId}" controls these fields. Either omit them or match the profile values.`,
          conflicts,
        });
        return;
      }
    }

    // Fetch original runs
    const originalRuns = await ctx.requestCollection.find(
      { _id: { $in: ids }, deletedAt: { $exists: false } }
    ).toArray();

    const foundIds = new Set(originalRuns.map(r => r._id));
    const notFound = ids.filter((id: string) => !foundIds.has(id));

    const submissionId = uuidv4();
    const newIds: string[] = [];
    const newDocs: RequestDocument[] = [];

    for (const original of originalRuns) {
      for (let i = 0; i < count; i++) {
        const requestId = uuidv4();
        const runId = uuidv4();
        newIds.push(requestId);

        // Determine effective profile for this run
        // overrideProfileId: undefined = keep original, null = detach, string = use new profile
        let effectiveProfileId: string | undefined;
        let effectiveProfileVersionId: string | undefined;
        let activeProfileVersion: ProfileVersionDocument | null = null;
        if (overrideProfileId === null) {
          // Explicitly detached — no profile
        } else if (typeof overrideProfileId === "string") {
          effectiveProfileId = overrideProfileId;
          effectiveProfileVersionId = overrideProfileVersionId;
          activeProfileVersion = overrideProfileVersion;
        } else {
          // undefined — keep from original
          effectiveProfileId = original.profileId;
          effectiveProfileVersionId = original.profileVersionId;
          // If the original had a profile, resolve its version for field overrides
          if (original.profileId && original.profileVersionId) {
            activeProfileVersion = await ctx.profileVersionCollection.findOne({
              projectId: original.projectId,
              $or: [{ ref: original.profileVersionId }, { _id: original.profileVersionId }],
            });
          }
        }

        // When a profile is active, its values take precedence over individual overrides
        // for the fields it controls: workerType, model, mcpServers, skillRevisions, extensions
        const effectiveWorkerType = (activeProfileVersion
          ? activeProfileVersion.workerType
          : (overrides?.workerType ?? original.workerType)) as WorkerType;
        let effectiveModel = activeProfileVersion
          ? activeProfileVersion.model
          : (overrides?.model !== undefined ? overrides.model : original.model);
        const effectiveReasoningEffort = activeProfileVersion?.reasoningEffort
          ? activeProfileVersion.reasoningEffort
          : (overrides?.reasoningEffort !== undefined ? overrides.reasoningEffort : original.reasoningEffort);
        const effectiveMaxIterations = overrides?.maxIterations !== undefined ? overrides.maxIterations : original.maxIterations;
        const effectiveMcpServers = activeProfileVersion
          ? (activeProfileVersion.mcpServers ?? null)
          : (overrides?.mcpServers !== undefined ? overrides.mcpServers : original.mcpServers);
        const effectiveSkillRevisions = activeProfileVersion
          ? (activeProfileVersion.skillRevisions ?? null)
          : (overrides?.skillRevisions !== undefined ? overrides.skillRevisions : original.skillRevisions);
        // Resolve skill specs to pinned refs (handles both bare slugs and already-pinned refs)
        let resolvedSkillRevisions: string[] | null = null;
        if (effectiveSkillRevisions && effectiveSkillRevisions.length > 0) {
          const result = await resolveSkillSpecs(effectiveSkillRevisions, ctx, original.projectId);
          if (result.error) {
            res.status(422).json({ error: `Skill resolution failed during resubmit: ${result.error}` });
            return;
          }
          resolvedSkillRevisions = result.refs ?? null;
        }
        const effectiveExtensions = activeProfileVersion
          ? (activeProfileVersion.extensions ?? null)
          : (overrides?.extensions !== undefined ? overrides.extensions : original.extensions);

        const resubmitPlan = planResubmitResources(
          overrideProfileId,
          original.resources,
          normalizeResourceBindingSpecs(activeProfileVersion?.resources),
        );
        let effectiveResources: ResourceBinding[] | null = null;
        if (resubmitPlan.kind === "resolve") {
          const resolvedResources = await resolveResourceBindings(
            ctx,
            original.projectId,
            undefined,
            resubmitPlan.specs,
          );
          if (resolvedResources.errors.length > 0) {
            res.status(422).json({
              error: `Resource resolution failed during resubmit: ${resolvedResources.errors.join("; ")}`,
            });
            return;
          }
          effectiveResources = resolvedResources.bindings ?? null;
        } else {
          effectiveResources = resubmitPlan.bindings;
        }

        const targetCheck = await validateAgentTarget(ctx.agentCollection, {
          workerType: effectiveWorkerType,
          requestedVersion:
            activeProfileVersion?.agentVersion ??
            overrides?.agentVersion,
          model: effectiveModel ?? undefined,
          requirements: requestedAgentCapabilities({
            reasoningEffort: effectiveReasoningEffort,
            mcpServers: effectiveMcpServers,
            skillRevisions: effectiveSkillRevisions,
            extensions: effectiveExtensions,
            resources: effectiveResources,
          }),
          strictCapabilities: ctx.strictAgentCapabilities,
        });
        if (!targetCheck.ok) {
          const { ok: _ok, status, ...payload } = targetCheck;
          res.status(status).json({
            ...payload,
            originalRequestId: original._id,
          });
          return;
        }
        effectiveModel = targetCheck.model;
        const resolvedAgentVersion = targetCheck.agentVersion;

        const newDoc: RequestDocument = {
          _id: requestId,
          projectId: original.projectId,
          scenario: original.scenario,
          workerType: effectiveWorkerType,
          createdAt: new Date(),
          priority: original.priority ?? 0,
          ...(effectiveMaxIterations ? { maxIterations: effectiveMaxIterations } : {}),
          ...(original.personaInstructions ? { personaInstructions: original.personaInstructions } : {}),
          ...(original.persona ? { persona: original.persona } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
          ...(effectiveMcpServers && effectiveMcpServers.length > 0 ? { mcpServers: effectiveMcpServers } : {}),
          ...(resolvedSkillRevisions && resolvedSkillRevisions.length > 0 ? { skillRevisions: resolvedSkillRevisions } : {}),
          ...(effectiveExtensions && effectiveExtensions.length > 0 ? { extensions: effectiveExtensions } : {}),
          ...(effectiveResources && effectiveResources.length > 0 ? { resources: effectiveResources } : {}),
          agentVersion: resolvedAgentVersion,
          ...(original.taskPromptId ? { taskPromptId: original.taskPromptId } : {}),
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
          ...(effectiveProfileVersionId ? { profileVersionId: effectiveProfileVersionId } : {}),
          // Preserve AGENTS.md lineage across re-submits.
          ...(original.agentsMdPromptId ? { agentsMdPromptId: original.agentsMdPromptId } : {}),
          ...(original.agentsMdParentIds && original.agentsMdParentIds.length > 0 ? { agentsMdParentIds: original.agentsMdParentIds } : {}),
          submissionId,
          // Bulk re-submit creates a brand-new request — mint a distinct
          // run id for the first attempt so blob artifacts live under
          // `{requestId}/runs/{runId}/...` (independent of the original run).
          run: { _id: runId, attemptNumber: 1, status: "pending", logsUrl: ctx.blobStorage.getLogsBlobUrl(`${requestId}/runs/${runId}/run.jsonl`) },
        };

        newDocs.push(newDoc);
      }
    }

    // Insert all new documents — scheduler will dispatch to queues
    if (newDocs.length > 0) {
      await ctx.requestCollection.insertMany(newDocs);
    }

    console.log(`Bulk re-submitted ${newIds.length} runs from ${originalRuns.length} originals (count=${count})`);

    res.status(201).json({
      submitted: newIds.length,
      failed: notFound,
      newIds,
      submissionId,
    });
  },
});

// Bulk soft-delete requests
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/requests/bulk",
  tags: ["Requests"],
  summary: "Bulk soft-delete requests",
  body: z.object({ ids: z.array(z.string()) }),
  response: z.object({ deleted: z.number() }),
  handler: async (req, res) => {
    const { ids } = req.body as { ids?: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "Request body must include 'ids' array" });
      return;
    }

    // Find which IDs exist and are not already deleted
    const existingDocs = await ctx.requestCollection.find(
      { _id: { $in: ids }, deletedAt: { $exists: false } },
      { projection: { _id: 1 } }
    ).toArray();
    const existingIds = new Set(existingDocs.map(d => d._id));

    // Soft-delete all matching documents
    const result = await ctx.requestCollection.updateMany(
      { _id: { $in: ids }, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    // Determine which IDs were not found or already deleted
    const notFound = ids.filter(id => !existingIds.has(id));

    res.json({
      deleted: result.modifiedCount,
      notFound,
    });
  },
});

// Soft-delete a request
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/requests/:id",
  tags: ["Requests"],
  summary: "Soft-delete request",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id } = req.params;

    const result = await ctx.requestCollection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      const exists = await ctx.requestCollection.findOne({ _id: id });
      if (!exists) {
        res.status(404).json({ error: "Request not found" });
      } else {
        res.status(410).json({ error: "Request already deleted" });
      }
      return;
    }

    res.json({ id, deleted: true });
  },
});

// Download a batch archive of multiple runs
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/archive",
  tags: ["Requests"],
  summary: "Download batch archive of multiple runs",
  body: z.object({ ids: z.array(z.string()).min(1).max(100) }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped batch archive containing individual run archives",
  errorResponses: {
    400: { description: "Invalid input" },
    404: { description: "One or more runs not found" },
  },
  handler: async (req, res) => {
    try {
      const { ids } = req.body;

      // Fetch all requested runs
      const runs = await ctx.requestCollection.find({ _id: { $in: ids } }).toArray();
      const foundIds = new Set(runs.map(r => r._id));
      const missingIds = ids.filter(id => !foundIds.has(id));
      if (missingIds.length > 0) {
        res.status(404).json({ error: "Runs not found", missingIds });
        return;
      }

      // Connect to blob storage
      let blobServiceClient: BlobServiceClient;
      if (ctx.storageConnectionString) {
        blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
      } else {
        blobServiceClient = new BlobServiceClient(
          `https://${ctx.storageAccountName}.blob.core.windows.net`,
          new DefaultAzureCredential()
        );
      }
      const containerClient = blobServiceClient.getContainerClient("snapshots");
      const logsContainerClient = blobServiceClient.getContainerClient("logs");

      // Set response headers before streaming
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="batch-${timestamp}.tar.gz"`);

      // Create streaming tar+gzip pipeline → response
      const pack = tarPack();
      const gzip = createGzip();
      pack.pipe(gzip).pipe(res);

      const isBlobNotFound = (err: unknown) =>
        err instanceof RestError && (err.statusCode === 404 || err.code === "ContainerNotFound" || err.code === "BlobNotFound");

      // Pack each run into the archive
      for (const run of runs) {
        await packRunIntoTar(pack, run, containerClient, run._id, isBlobNotFound, logsContainerClient);
      }

      // Finalize the tar archive
      pack.finalize();
    } catch (error) {
      if (!res.headersSent) {
        if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
          res.status(404).json({ error: "Snapshot not found — the blob may have been deleted or is no longer available" });
          return;
        }
        throw error;
      } else {
        res.destroy();
      }
    }
  },
});

// --- Runs upload (import downloaded archives) ---

// ── Streaming run-archive import ──────────────────────────────────────────
//
// Both upload endpoints below share a single streaming pipeline:
//
//   HTTP body → gunzip → tar-extract → per-entry blob.uploadStream
//
// The decompressed bytes never hit the local filesystem. Only the small
// `run.yaml` is buffered (it has to be parsed before we can construct the
// Mongo document). All artifact bytes (iteration tarballs, HARs, chat
// exports, tool calls, logs.jsonl) flow straight from the tar entry into
// Azure block-blob storage. Multer still stages the (compressed) HTTP body
// to a tmp file when the request is multipart/form-data so the existing
// CLI contract keeps working; raw `application/gzip` POSTs skip multer
// entirely and pipe `req` directly into the pipeline.

/** Errors thrown by the streaming pipeline that map cleanly to HTTP responses. */
class ImportError extends Error {
  constructor(public statusCode: number, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

function buildBlobServiceClient(): BlobServiceClient {
  if (ctx.storageConnectionString) {
    return BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
  }
  return new BlobServiceClient(
    `https://${ctx.storageAccountName}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );
}

interface ImportSuccess {
  id: string;
  status: string;
  iterations: number;
}

interface ImportFailure {
  id?: string;
  error: string;
  statusCode: number;
  details?: Record<string, unknown>;
}

interface PendingRun {
  /** Buffered run.yaml bytes (parsed at finalize time). */
  yamlBuf?: Buffer;
  /** Maps tar-entry filename (without the `<runId>/` prefix) → uploaded blob URL. */
  artifacts: Map<string, string>;
  /**
   * BlockBlobClient handles for every artifact we successfully uploaded for
   * this run. Used to cleanup-on-failure: if `finalizePendingRun` rejects
   * (bad yaml, duplicate _id, …) we delete these blobs so a failed import
   * never leaves orphans behind.
   */
  uploadedBlobs: BlockBlobClient[];
  /** Number of iteration-N.tar.gz entries seen for this run. */
  iterationCount: number;
  /** Per-entry upload errors, surfaced as a single per-run failure at finalize. */
  uploadErrors: string[];
  /**
   * Path to a tmp file holding logs.jsonl bytes. The blob's canonical path
   * embeds the per-attempt `run._id` (`{requestId}/runs/{runId}/run.jsonl`)
   * which we don't know until run.yaml has been parsed. So we stage the
   * bytes locally during the streaming pass and upload them in finalize
   * once we know the right destination path.
   */
  logsTempPath?: string;
}

/**
 * Best-effort delete of every blob this run uploaded plus any staged
 * logs.jsonl tmp file. Called when a run's finalize step fails (validation,
 * duplicate _id, …) or when the streaming pipeline aborts mid-archive.
 * Errors are swallowed — we've already failed the import, the goal is just
 * to minimise orphaned blobs and tmp files.
 */
async function cleanupRunBlobs(run: PendingRun): Promise<void> {
  if (run.logsTempPath && existsSync(run.logsTempPath)) {
    try { rmSync(run.logsTempPath, { force: true }); } catch { /* swallow */ }
  }
  if (run.uploadedBlobs.length === 0) return;
  await Promise.allSettled(run.uploadedBlobs.map(c => c.deleteIfExists()));
}

/**
 * Map an archive entry filename to its canonical destination blob.
 * Returns null for unrecognised entries (which are drained and skipped).
 */
function canonicalBlobTarget(
  runId: string,
  filename: string,
): { container: "snapshots" | "logs"; blobPath: string; contentType: string; iteration?: number; isIteration?: boolean } | null {
  let m = filename.match(/^iteration-(\d+)\.tar\.gz$/);
  if (m) return { container: "snapshots", blobPath: `${runId}/iteration-${m[1]}/workspace.tar.gz`, contentType: "application/gzip", iteration: Number(m[1]), isIteration: true };
  m = filename.match(/^iteration-(\d+)\.har$/);
  if (m) return { container: "snapshots", blobPath: `${runId}/iteration-${m[1]}/capture.har`, contentType: "application/json", iteration: Number(m[1]) };
  if (filename === "run.har") return { container: "snapshots", blobPath: `${runId}/capture.har`, contentType: "application/json" };
  m = filename.match(/^iteration-(\d+)\.chat-export\.json$/);
  if (m) return { container: "snapshots", blobPath: `${runId}/iteration-${m[1]}/chat-export.json`, contentType: "application/json", iteration: Number(m[1]) };
  if (filename === "run.chat-export.json") return { container: "snapshots", blobPath: `${runId}/chat-export.json`, contentType: "application/json" };
  m = filename.match(/^iteration-(\d+)\.chat-result\.json$/);
  if (m) return { container: "snapshots", blobPath: `${runId}/iteration-${m[1]}/chat-result.json`, contentType: "application/json", iteration: Number(m[1]) };
  m = filename.match(/^iteration-(\d+)\.tool-calls\.jsonl$/);
  if (m) return { container: "snapshots", blobPath: `${runId}/iteration-${m[1]}/tool-calls.jsonl`, contentType: "application/x-ndjson", iteration: Number(m[1]) };
  // logs.jsonl is intentionally NOT mapped here. Its canonical blob path
  // embeds the per-attempt `run._id` from run.yaml, which we don't know
  // during the streaming pass. The pipeline stages it to a tmp file and
  // uploads it in finalize once the yaml has been parsed.
  return null;
}

/** Read a tar-stream entry stream into a Buffer (only used for `run.yaml`). */
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Validate a buffered run.yaml + accumulated artifact URLs and insert the
 * resulting Mongo document. Throws ImportError on validation/conflict
 * failures (mapped to HTTP status by the caller).
 */
async function finalizePendingRun(
  prefix: string,
  run: PendingRun,
  blobServiceClient: BlobServiceClient,
  projectId: string,
): Promise<ImportSuccess> {
  if (run.uploadErrors.length > 0) {
    throw new ImportError(500, `Blob upload failures: ${run.uploadErrors.join("; ")}`);
  }
  if (!run.yamlBuf) {
    throw new ImportError(400, `Archive subdirectory "${prefix}/" is missing run.yaml`);
  }

  let runDocRaw: unknown;
  try {
    runDocRaw = yamlParse(run.yamlBuf.toString("utf-8")) as unknown;
  } catch (parseErr) {
    throw new ImportError(400, `Failed to parse run.yaml: ${parseErr}`);
  }

  const ImportSchema = RequestResponseSchema.extend({ run: RunStateSchema });
  const parsed = ImportSchema.safeParse(runDocRaw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => ({
      path: i.path.join(".") || "<root>",
      message: i.message,
    }));
    throw new ImportError(
      400,
      `Invalid run.yaml: ${issues.map(i => `${i.path}: ${i.message}`).join("; ")}`,
      { details: issues },
    );
  }
  const runDoc = parsed.data;
  const runState = runDoc.run;

  // The exporter always names the wrapping directory after the request's
  // top-level `_id`. If the prefix on the wire diverges, refuse — otherwise
  // the blobs we just streamed live under the wrong requestId and the
  // inserted Mongo document would point at nothing.
  if (runDoc._id !== prefix) {
    throw new ImportError(
      400,
      `run.yaml _id "${runDoc._id}" does not match archive subdirectory "${prefix}"`,
    );
  }

  const terminalStatuses = ["done"];
  if (!terminalStatuses.includes(runState.status)) {
    throw new ImportError(
      400,
      `Cannot upload in-flight run (status: ${runState.status}). Only terminal runs can be uploaded.`,
    );
  }

  const existingRun = await ctx.requestCollection.findOne({ _id: runDoc._id });
  if (existingRun) {
    throw new ImportError(
      409,
      `Run with ID '${runDoc._id}' already exists`,
      { existingStatus: existingRun.run?.status },
    );
  }

  // logs.jsonl was staged to a tmp file during the streaming pass because
  // its canonical blob path embeds the per-attempt `run._id` which only
  // becomes known after yaml parse. Upload it now to the right destination
  // and record the new URL on runState.
  let newLogsUrl: string | undefined;
  if (run.logsTempPath) {
    const logsContainer = blobServiceClient.getContainerClient("logs");
    const logsBlobPath = `${runDoc._id}/runs/${runState._id}/run.jsonl`;
    const logsClient = logsContainer.getBlockBlobClient(logsBlobPath);
    try {
      await logsClient.uploadStream(
        createReadStream(run.logsTempPath),
        undefined,
        undefined,
        {
          blobHTTPHeaders: { blobContentType: "application/x-ndjson" },
          tags: { requestId: runDoc._id, runId: runState._id },
          conditions: { ifNoneMatch: "*" },
        },
      );
      run.uploadedBlobs.push(logsClient);
      newLogsUrl = logsClient.url;
    } finally {
      try { rmSync(run.logsTempPath, { force: true }); } catch { /* swallow */ }
      run.logsTempPath = undefined;
    }
  }

  // Resolve per-turn URLs from the artifacts we streamed.
  const turns = (runState.turns ?? []).map(t => ({ ...t }));
  for (const turn of turns) {
    const N = turn.iteration;
    const snap = run.artifacts.get(`iteration-${N}.tar.gz`);
    if (snap) (turn as { snapshotUrl?: string }).snapshotUrl = snap;
    const har = run.artifacts.get(`iteration-${N}.har`);
    if (har) (turn as { harUrl?: string }).harUrl = har;
    const chat = run.artifacts.get(`iteration-${N}.chat-export.json`);
    if (chat) (turn as { rawChatUrl?: string }).rawChatUrl = chat;
    const chatRes = run.artifacts.get(`iteration-${N}.chat-result.json`);
    if (chatRes) (turn as { chatResultUrl?: string }).chatResultUrl = chatRes;
    const tc = run.artifacts.get(`iteration-${N}.tool-calls.jsonl`);
    if (tc) (turn as { toolCallsUrl?: string }).toolCallsUrl = tc;
  }
  const topHar = run.artifacts.get("run.har");
  if (topHar) runState.harUrl = topHar;
  const topChat = run.artifacts.get("run.chat-export.json");
  if (topChat) runState.rawChatUrl = topChat;

  // Materialize the task-prompt entity for this run. The submission flow
  // (POST /api/v1/requests) goes through `taskPromptStore.findOrCreate` so
  // every run has a row in the `task-prompts` collection that backs
  // features, report triggers, group-by-task, the runs-list task filter and
  // the criteria/MDP analysis. Imported runs used to skip this step:
  // `taskPromptId` was preserved from `run.yaml` but no row was ever
  // created, leaving a dangling reference that joined to nothing.
  //
  // `findOrCreate` is idempotent and content-addressed (UUIDv5 from the
  // trimmed task text) — when the imported `taskPromptId` is correct it
  // simply matches the returned `_id`; when it is missing or stale we
  // overwrite it with the canonical id.
  const taskPrompt = await ctx.taskPromptStore.findOrCreate(projectId, runDoc.scenario.task);
  const resolvedTaskPromptId = taskPrompt._id;

  // Build the document by spreading the validated yaml — zod has already
  // stripped any unknown fields, so what's in `runDoc` is exactly the
  // optional surface we care to preserve (taskPromptId, model, agentVersion,
  // mcpServers, skillRevisions, extensions, profileId, profileVersionId,
  // run.os, run.workerVersion, run.aiCallCount, run.startedAt,
  // run.finishedAt, …). The previous allowlist construction silently
  // dropped all of these on round-trip.
  const docToInsert: RequestDocument = {
    ...(runDoc as unknown as RequestDocument),
    // Import always files the run into the caller-selected project, remapping
    // any projectId carried in the archive so imports stay portable across
    // environments (a serialized projectId won't exist in the target).
    projectId,
    workerType: runDoc.workerType as WorkerType,
    createdAt: runDoc.createdAt ?? new Date(),
    priority: runDoc.priority ?? 0,
    taskPromptId: resolvedTaskPromptId,
    ...(runDoc.submissionId ? {} : { submissionId: uuidv4() }),
    run: {
      ...(runState as unknown as RunState),
      // Per-attempt `run._id` is preserved from the yaml (NOT clobbered
      // with the request `_id`) so retries / history demotion still work.
      logsUrl: newLogsUrl ?? runState.logsUrl,
      ...(runState.harUrl ? { harUrl: runState.harUrl } : {}),
      ...(runState.rawChatUrl ? { rawChatUrl: runState.rawChatUrl } : {}),
      turns,
      // Denormalize duration so imported finished runs are immediately
      // sortable by duration (before the backfill migration runs).
      ...(runDurationMs(runState.startedAt, runState.finishedAt) !== undefined
        ? { durationMs: runDurationMs(runState.startedAt, runState.finishedAt) }
        : {}),
    },
  };

  await ctx.requestCollection.insertOne(docToInsert);

  return { id: runDoc._id, status: runState.status, iterations: run.iterationCount };
}

/**
 * Stream a gzipped tar archive directly into blob storage + Mongo. Handles
 * one or many runs in the same archive. Per-run failures are isolated:
 * one bad run.yaml or one duplicate `_id` does not abort the rest.
 *
 * Archive layout requirement: every entry must live under a top-level
 * `<runId>/` subdirectory. The exporter always produces this layout for
 * both single-run (`GET /requests/:id/archive`) and batch
 * (`POST /requests/archive`) downloads.
 */
async function streamArchiveImport(
  archiveStream: NodeJS.ReadableStream,
  blobServiceClient: BlobServiceClient,
  projectId: string,
): Promise<{ imported: ImportSuccess[]; failed: ImportFailure[] }> {
  const snapshotsContainer = blobServiceClient.getContainerClient("snapshots");
  await snapshotsContainer.createIfNotExists();
  const logsContainer = blobServiceClient.getContainerClient("logs");
  await logsContainer.createIfNotExists();

  // Per-import scratch dir for staging logs.jsonl entries (one file per
  // run). Removed in finally regardless of outcome.
  const importTmpDir = mkdtempSync(join(tmpdir(), "scope-import-"));

  const pending = new Map<string, PendingRun>();
  const extractErrors: string[] = [];
  const extract = tarExtract();

  extract.on("entry", (header, entryStream, next) => {
    // Split path into "<prefix>/<filename>". We require a non-empty prefix:
    // it doubles as the runId (the exporter always wraps each run in its
    // `_id`-named directory) so we can derive canonical blob paths up
    // front, before run.yaml is parsed. This keeps the pipeline pure
    // streaming — no buffering of large iteration tarballs.
    const slash = header.name.indexOf("/");
    if (slash <= 0 || slash === header.name.length - 1) {
      // Root-level entry or trailing slash — drain & skip with an error
      // recorded against the whole archive.
      extractErrors.push(`Archive entry "${header.name}" must live under a <runId>/ subdirectory`);
      entryStream.on("end", next);
      entryStream.on("error", next);
      entryStream.resume();
      return;
    }
    const prefix = header.name.slice(0, slash);
    const filename = header.name.slice(slash + 1);

    let run = pending.get(prefix);
    if (!run) {
      run = { artifacts: new Map(), uploadedBlobs: [], iterationCount: 0, uploadErrors: [] };
      pending.set(prefix, run);
    }

    if (filename === "run.yaml") {
      streamToBuffer(entryStream)
        .then(buf => {
          run!.yamlBuf = buf;
          next();
        })
        .catch(err => {
          run!.uploadErrors.push(`run.yaml read: ${err.message ?? err}`);
          next();
        });
      return;
    }

    // logs.jsonl is staged to a tmp file because its destination blob path
    // embeds the per-attempt `run._id` which only becomes known after yaml
    // parse. The bytes still flow as a stream — just to disk first, then
    // back out to Azure during finalize — so this doesn't blow up memory.
    if (filename === "logs.jsonl") {
      const tmpPath = join(importTmpDir, `${prefix}-logs.jsonl`);
      const ws = createWriteStream(tmpPath);
      pipeline(entryStream as Readable, ws)
        .then(() => {
          run!.logsTempPath = tmpPath;
          next();
        })
        .catch(err => {
          run!.uploadErrors.push(`logs.jsonl read: ${err.message ?? err}`);
          next();
        });
      return;
    }

    const target = canonicalBlobTarget(prefix, filename);
    if (!target) {
      // Unknown entry — drain & skip silently. Forward-compatible with
      // future archive additions.
      entryStream.on("end", next);
      entryStream.on("error", next);
      entryStream.resume();
      return;
    }

    const container = target.container === "logs" ? logsContainer : snapshotsContainer;
    const blockBlobClient = container.getBlockBlobClient(target.blobPath);
    const tags: Record<string, string> = { requestId: prefix };
    if (target.iteration !== undefined) tags.iteration = String(target.iteration);

    blockBlobClient
      .uploadStream(entryStream as Readable, undefined, undefined, {
        blobHTTPHeaders: { blobContentType: target.contentType },
        tags,
        // Refuse to clobber an existing blob. If a run with this `_id` was
        // already imported, its artifacts are at the same canonical paths;
        // overwriting them before we discover the duplicate via Mongo would
        // destroy live data. With this guard the upload fails fast (412)
        // and the per-run cleanup just deletes whatever fresh blobs we did
        // manage to write, leaving the existing run intact.
        conditions: { ifNoneMatch: "*" },
      })
      .then(() => {
        run!.artifacts.set(filename, blockBlobClient.url);
        run!.uploadedBlobs.push(blockBlobClient);
        if (target.isIteration) run!.iterationCount++;
        next();
      })
      .catch(err => {
        run!.uploadErrors.push(`${filename}: ${err.message ?? err}`);
        // The Azure SDK consumes the stream itself; we just need to advance.
        next();
      });
  });

  try {
    await pipeline(archiveStream, createGunzip(), extract);
  } catch (err) {
    // Pipeline aborted mid-archive (network drop, malformed gzip, etc.).
    // Best-effort cleanup of every artifact we managed to upload before
    // re-throwing so the caller surfaces the failure to the client.
    await Promise.allSettled([...pending.values()].map(cleanupRunBlobs));
    try { rmSync(importTmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
    throw err;
  }

  if (extractErrors.length > 0 && pending.size === 0) {
    // Entire archive was malformed — surface as a single import failure.
    try { rmSync(importTmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
    throw new ImportError(400, extractErrors.join("; "));
  }

  const imported: ImportSuccess[] = [];
  const failed: ImportFailure[] = [];
  try {
    for (const [prefix, run] of pending) {
      try {
        imported.push(await finalizePendingRun(prefix, run, blobServiceClient, projectId));
      } catch (err) {
        // Per-run failure — delete this run's blobs so a bad run.yaml or a
        // duplicate _id never leaves orphans behind. Other runs in the batch
        // are unaffected (cleanup is scoped to `run.uploadedBlobs`).
        await cleanupRunBlobs(run);
        if (err instanceof ImportError) {
          failed.push({
            id: prefix,
            error: err.message,
            statusCode: err.statusCode,
            ...(err.details ? { details: err.details } : {}),
          });
        } else {
          failed.push({ id: prefix, error: err instanceof Error ? err.message : String(err), statusCode: 500 });
        }
      }
    }
  } finally {
    try { rmSync(importTmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
  }

  return { imported, failed };
}

/**
 * Resolve the gzipped-tar input stream from an Express request. Supports
 * two transports:
 *   - multipart/form-data with field "archive" (used by the CLI today —
 *     multer stages the *compressed* archive on disk; the decompressed
 *     content never lands on disk).
 *   - raw `application/gzip` (or `application/octet-stream`) body — `req`
 *     itself is the stream, no staging at all.
 */
function getArchiveStream(req: { file?: { path: string }; readable?: boolean } & NodeJS.ReadableStream): {
  stream: NodeJS.ReadableStream;
  cleanup: () => void;
} {
  if (req.file?.path) {
    const path = req.file.path;
    return {
      stream: createReadStream(path),
      cleanup: () => {
        if (existsSync(path)) rmSync(path, { force: true });
      },
    };
  }
  return { stream: req, cleanup: () => {} };
}

// POST /api/v1/runs/upload — Import a single run archive (tar.gz).
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/runs/upload",
  tags: ["Requests"],
  summary: "Import run archive",
  middleware: [upload.single("archive")],
  query: ProjectIdQuerySchema,
  response: RequestResponseSchema,
  rawResponse: true,
  successStatus: 201,
  handler: async (req, res) => {
    const projectId = getQueryProjectId(req);
    // Reject obviously empty requests up front so the streaming pipeline
    // doesn't blow up trying to gunzip nothing. multer leaves req.file
    // undefined when the multipart body has no "archive" field; raw POSTs
    // must declare a gzip-ish content-type to count.
    const typed = req as Parameters<typeof getArchiveStream>[0];
    const isMultipart = req.is("multipart/form-data");
    const isRawGzip = req.is("application/gzip") || req.is("application/octet-stream");
    if (!typed.file && !isRawGzip) {
      const hint = isMultipart
        ? "Use 'archive' field for the tar.gz file."
        : "Send the .tar.gz body with Content-Type: application/gzip, or as multipart/form-data with field 'archive'.";
      res.status(400).json({ error: `No archive file uploaded. ${hint}` });
      return;
    }
    const { stream, cleanup } = getArchiveStream(typed);
    try {
      let result: { imported: ImportSuccess[]; failed: ImportFailure[] };
      try {
        result = await streamArchiveImport(stream, buildBlobServiceClient(), projectId);
      } catch (err) {
        if (err instanceof ImportError) {
          res.status(err.statusCode).json({ error: err.message, ...(err.details ?? {}) });
          return;
        }
        throw err;
      }

      // Single-archive contract: archive must contain exactly one run.
      if (result.imported.length === 0 && result.failed.length === 0) {
        res.status(400).json({ error: "Archive contains no runs" });
        return;
      }
      if (result.imported.length === 0) {
        const f = result.failed[0];
        res.status(f.statusCode).json({ error: f.error, ...(f.details ?? {}) });
        return;
      }
      if (result.imported.length + result.failed.length > 1) {
        res.status(400).json({
          error: "Archive contains multiple runs; use POST /api/v1/runs/upload-batch for batch imports",
        });
        return;
      }

      const ok = result.imported[0];
      console.log(`Uploaded run ${ok.id} with ${ok.iterations} iterations`);
      res.status(201).json({
        id: ok.id,
        status: ok.status,
        iterations: ok.iterations,
        message: "Run uploaded successfully",
      });
    } finally {
      cleanup();
    }
  },
});

// POST /api/v1/runs/upload-batch — Import a batch run archive (multiple
// runs in one tar.gz, as produced by POST /api/v1/requests/archive). Per-run
// failures are isolated and reported alongside successes.
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/runs/upload-batch",
  tags: ["Requests"],
  summary: "Import batch run archive",
  middleware: [upload.single("archive")],
  response: z.object({
    imported: z.array(z.object({
      id: z.string(),
      status: z.string(),
      iterations: z.number(),
    })),
    failed: z.array(z.object({
      id: z.string().optional(),
      error: z.string(),
      statusCode: z.number(),
    })),
  }),
  rawResponse: true,
  // Status is computed dynamically based on imported/failed counts; this
  // value is only used for OpenAPI docs.
  successStatus: 207,
  responseDescription:
    "Multi-status: 201 if all runs imported, 400 if none imported, 207 if partial",
  errorResponses: {
    400: { description: "No archive uploaded, empty archive, or all runs failed" },
  },
  query: ProjectIdQuerySchema,
  handler: async (req, res) => {
    const projectId = getQueryProjectId(req);
    const typed = req as Parameters<typeof getArchiveStream>[0];
    const isMultipart = req.is("multipart/form-data");
    const isRawGzip = req.is("application/gzip") || req.is("application/octet-stream");
    if (!typed.file && !isRawGzip) {
      const hint = isMultipart
        ? "Use 'archive' field for the tar.gz file."
        : "Send the .tar.gz body with Content-Type: application/gzip, or as multipart/form-data with field 'archive'.";
      res.status(400).json({ error: `No archive file uploaded. ${hint}` });
      return;
    }
    const { stream, cleanup } = getArchiveStream(typed);
    try {
      let result: { imported: ImportSuccess[]; failed: ImportFailure[] };
      try {
        result = await streamArchiveImport(stream, buildBlobServiceClient(), projectId);
      } catch (err) {
        if (err instanceof ImportError) {
          res.status(err.statusCode).json({ error: err.message, ...(err.details ?? {}) });
          return;
        }
        throw err;
      }

      if (result.imported.length === 0 && result.failed.length === 0) {
        res.status(400).json({ error: "Batch archive contains no runs" });
        return;
      }

      for (const ok of result.imported) {
        console.log(`Uploaded run ${ok.id} with ${ok.iterations} iterations (batch)`);
      }

      // 201 if everything succeeded, 400 if nothing did, 207 otherwise.
      const status = result.failed.length === 0 ? 201 : result.imported.length === 0 ? 400 : 207;
      res.status(status).json(result);
    } finally {
      cleanup();
    }
  },
});


apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/reports",
  tags: ["Reports"],
  summary: "Get reports for request",
  params: z.object({ id: z.string() }),
  response: z.array(ReportResponseSchema),
  errorResponses: {
    404: { description: "Run not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;

      // Verify the run exists
      const run = await ctx.requestCollection.findOne({ _id: id });
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      const reports = await ctx.reportCollection
        .find({ requestId: id })
        .sort({ createdAt: -1 })
        .toArray();

      res.json(reports.map(r => ({ ...r, id: r._id })));
    } catch (error) {
      next(error);
    }
  },
});

// ─── Run-retry-attempts endpoints (issue #658) ────────────────────────────

// List all attempts for a request — current run (inline) + history (runs col),
// newest first.
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/runs",
  tags: ["Requests"],
  summary: "List attempts for a request",
  params: z.object({ id: z.string() }),
  response: z.array(RunStateSchema),
  errorResponses: { 404: { description: "Request not found" } },
  handler: async (req, res) => {
    const { id } = req.params;
    const request = await ctx.requestCollection.findOne({ _id: id });
    if (!request) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    const history = await listHistoricalRuns({ runsCollection: ctx.runsCollection }, id);
    const current = request.run ? [request.run] : [];
    // Combine current + history; current is always the highest attemptNumber
    res.json([...current, ...history]);
  },
});

// Get a single attempt by run id — checks current run first, then history.
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/runs/:runId",
  tags: ["Requests"],
  summary: "Get a single attempt",
  params: z.object({ id: z.string(), runId: z.string() }),
  response: RunStateSchema,
  errorResponses: { 404: { description: "Request or run not found" } },
  handler: async (req, res) => {
    const { id, runId } = req.params;
    const request = await ctx.requestCollection.findOne({ _id: id });
    if (!request) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (request.run?._id === runId) {
      res.json(request.run);
      return;
    }
    const historical = await getHistoricalRun({ runsCollection: ctx.runsCollection }, runId);
    if (!historical || historical.requestId !== id) {
      res.status(404).json({ error: "Run not found for this request" });
      return;
    }
    res.json(historical);
  },
});

// Bulk retry terminal requests — demotes each current run to history,
// creates fresh attempts, and re-queues. Non-terminal runs are skipped.
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/bulk-retry",
  tags: ["Requests"],
  summary: "Bulk retry requests (start new attempts)",
  body: z.object({ ids: z.array(z.string()).min(1), force: z.boolean().optional() }),
  response: z.object({
    retried: z.number().int(),
    skipped: z.number().int(),
    results: z.array(z.object({
      requestId: z.string(),
      runId: z.string().optional(),
      attemptNumber: z.number().int().optional(),
      error: z.string().optional(),
    })),
  }),
  handler: async (req, res) => {
    const { ids, force } = req.body;

    // Fetch all requested documents
    const requests = await ctx.requestCollection.find(
      { _id: { $in: ids }, deletedAt: { $exists: false } },
    ).toArray();
    const requestMap = new Map(requests.map((r) => [r._id, r]));

    const results: Array<{ requestId: string; runId?: string; attemptNumber?: number; error?: string }> = [];
    let retried = 0;
    let skipped = 0;

    for (const id of ids) {
      const request = requestMap.get(id);
      if (!request) {
        results.push({ requestId: id, error: "Not found" });
        skipped++;
        continue;
      }

      const currentRun: RunState | undefined = request.run;
      if (currentRun?.status !== "done") {
        results.push({ requestId: id, error: `Status is '${currentRun?.status ?? "unknown"}', expected 'done'` });
        skipped++;
        continue;
      }

      if (currentRun.outcome === "succeeded" && !force) {
        results.push({ requestId: id, error: "Cannot retry a successful run unless force=true" });
        skipped++;
        continue;
      }

      const targetCheck = await validatePersistedRequestTarget(request);
      if (!targetCheck.ok) {
        results.push({
          requestId: id,
          error: `${targetCheck.error} (${targetCheck.errorCode})`,
        });
        skipped++;
        continue;
      }

      const runToDemote = currentRun;
      const newAttemptNumber = (runToDemote.attemptNumber ?? 1) + 1;
      const newRunId = uuidv4();
      const newRun: RunState = {
        _id: newRunId,
        attemptNumber: newAttemptNumber,
        status: "pending",
        logsUrl: ctx.blobStorage.getLogsBlobUrl(`${id}/runs/${newRunId}/run.jsonl`),
      };

      // 1. Demote current run to history
      try {
        await insertHistoricalRun({ runsCollection: ctx.runsCollection }, id, runToDemote, request.projectId);
      } catch (err: any) {
        if (err?.code !== 11000) {
          results.push({ requestId: id, error: "Failed to demote run to history" });
          skipped++;
          continue;
        }
      }

      // 2. Atomically swap
      const updateResult = await ctx.requestCollection.updateOne(
        { _id: id, "run._id": runToDemote._id },
        {
          $set: {
            run: newRun,
            agentVersion: targetCheck.agentVersion,
            updatedAt: new Date(),
          },
        },
      );
      if (updateResult.matchedCount === 0) {
        results.push({ requestId: id, error: "Race condition — another retry started first" });
        skipped++;
        continue;
      }

      // Scheduler will pick up the new run (status="pending") and dispatch.

      console.log(`Bulk retry: request ${id} → attempt ${newAttemptNumber} (runId=${newRunId})`);
      results.push({ requestId: id, runId: newRunId, attemptNumber: newAttemptNumber });
      retried++;
    }

    res.status(201).json({ retried, skipped, results });
  },
});

// Retry a failed (or otherwise terminal) request — demotes the current run
// to the history collection, creates a fresh attempt, and re-queues.
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/:id/retry",
  tags: ["Requests"],
  summary: "Retry a request (start a new attempt)",
  params: z.object({ id: z.string() }),
  body: z.object({ force: z.boolean().optional() }).optional(),
  response: z.object({
    requestId: z.string(),
    runId: z.string(),
    attemptNumber: z.number().int(),
  }),
  errorResponses: {
    404: { description: "Request not found" },
    409: { description: "Conflict — request is not in a retryable state, or a concurrent retry won the race" },
    422: { description: "Cannot retry — current run not yet terminal" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const force = req.body?.force === true;

    const request = await ctx.requestCollection.findOne({ _id: id });
    if (!request) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (request.deletedAt) {
      res.status(409).json({ error: "Cannot retry a deleted request" });
      return;
    }

    // The retry contract requires that the current attempt has reached a
    // terminal state.
    const currentRun = request.run;
    if (!currentRun || currentRun.status !== "done") {
      res.status(422).json({
        error: `Cannot retry: current run status is '${currentRun?.status ?? "unknown"}', expected 'done'`,
      });
      return;
    }
    if (currentRun.outcome === "succeeded" && !force) {
      res.status(409).json({
        error: "Cannot retry a successful run unless force=true in the request body",
      });
      return;
    }

    const targetCheck = await validatePersistedRequestTarget(request);
    if (!targetCheck.ok) {
      const { ok: _ok, status, ...payload } = targetCheck;
      res.status(status).json(payload);
      return;
    }

    const runToDemote = currentRun;

    const newAttemptNumber = (runToDemote.attemptNumber ?? 1) + 1;
    const newRunId = uuidv4();
    const newRun: RunState = {
      _id: newRunId,
      attemptNumber: newAttemptNumber,
      status: "pending",
      logsUrl: ctx.blobStorage.getLogsBlobUrl(`${id}/runs/${newRunId}/run.jsonl`),
    };

    // 1. Insert the demoted run into the history collection FIRST. If the
    //    request update fails afterwards we have a duplicate-history-entry
    //    risk on retry, but never history loss. Insert is idempotent on _id.
    try {
      await insertHistoricalRun({ runsCollection: ctx.runsCollection }, id, runToDemote, request.projectId);
    } catch (err: any) {
      // Duplicate key (already in history) is fine — proceed.
      if (err?.code !== 11000) throw err;
    }

    // 2. Atomically swap the current run on the request, gated on its _id
    //    so concurrent retries fail fast with a 409.
    const updateResult = await ctx.requestCollection.updateOne(
      { _id: id, "run._id": runToDemote._id },
      {
        $set: {
          run: newRun,
          agentVersion: targetCheck.agentVersion,
          updatedAt: new Date(),
        },
      },
    );

    if (updateResult.matchedCount === 0) {
      // Either the request vanished (deleted) or someone else retried first.
      res.status(409).json({
        error: "Retry race lost — another retry started a new attempt first",
      });
      return;
    }

    // Scheduler will pick up the new run (status="pending") and dispatch.

    console.log(
      `Retried request ${id}: attempt ${newAttemptNumber} (runId=${newRunId}), demoted ${runToDemote._id} to history`,
    );

    res.status(201).json({
      requestId: id,
      runId: newRunId,
      attemptNumber: newAttemptNumber,
    });
  },
});

// ── Priority ────────────────────────────────────────────────────────

// Set priority on a single request
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/:id/priority",
  tags: ["Requests"],
  summary: "Set priority on a single request",
  body: z.object({ priority: z.number().int() }),
  response: z.object({ id: z.string(), priority: z.number() }),
  handler: async (req, res) => {
    const { id } = req.params;
    const { priority } = req.body;
    const result = await ctx.requestCollection.updateOne(
      { _id: id, deletedAt: { $exists: false }, "run.status": { $in: ["pending", "paused"] } },
      { $set: { priority, updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      res.status(404).json({ error: `Request not found or not in a state that allows priority changes: ${id}` });
      return;
    }
    res.json({ id, priority });
  },
});

// Set priority on multiple requests
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/bulk-priority",
  tags: ["Requests"],
  summary: "Set priority on multiple requests",
  body: z.object({
    ids: z.array(z.string()).min(1).max(100),
    priority: z.number().int(),
  }),
  response: z.object({ updated: z.number(), skipped: z.number() }),
  handler: async (req, res) => {
    const { ids, priority } = req.body;
    const result = await ctx.requestCollection.updateMany(
      { _id: { $in: ids }, deletedAt: { $exists: false }, "run.status": { $in: ["pending", "paused"] } },
      { $set: { priority, updatedAt: new Date() } },
    );
    const updated = result.modifiedCount;
    res.json({ updated, skipped: ids.length - updated });
  },
});

// ── Pause / Resume ──────────────────────────────────────────────────

// Pause a single request
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/:id/pause",
  tags: ["Requests"],
  summary: "Pause a single request",
  response: z.object({ id: z.string(), status: z.string() }),
  handler: async (req, res) => {
    const { id } = req.params;
    const result = await ctx.requestCollection.updateOne(
      {
        _id: id,
        "run.status": { $in: ["pending", "queued"] },
        deletedAt: { $exists: false },
      },
      {
        $set: {
          "run.status": "paused",
          "run.pausedAt": new Date(),
          "run.updatedAt": new Date(),
          updatedAt: new Date(),
        },
      },
    );
    if (result.matchedCount === 0) {
      // Check if exists at all
      const doc = await ctx.requestCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!doc) {
        res.status(404).json({ error: `Request not found: ${id}` });
        return;
      }
      res.status(409).json({
        error: `Cannot pause request in status "${doc.run?.status}". Only pending or queued requests can be paused.`,
      });
      return;
    }
    res.json({ id, status: "paused" });
  },
});

// Resume a single request
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/:id/resume",
  tags: ["Requests"],
  summary: "Resume a paused request",
  response: z.object({ id: z.string(), status: z.string() }),
  handler: async (req, res) => {
    const { id } = req.params;
    const result = await ctx.requestCollection.updateOne(
      {
        _id: id,
        "run.status": "paused",
        deletedAt: { $exists: false },
      },
      {
        $set: {
          "run.status": "pending",
          "run.resumedAt": new Date(),
          "run.updatedAt": new Date(),
          updatedAt: new Date(),
        },
      },
    );
    if (result.matchedCount === 0) {
      const doc = await ctx.requestCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!doc) {
        res.status(404).json({ error: `Request not found: ${id}` });
        return;
      }
      res.status(409).json({
        error: `Cannot resume request in status "${doc.run?.status}". Only paused requests can be resumed.`,
      });
      return;
    }
    res.json({ id, status: "pending" });
  },
});

// Bulk pause
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/bulk-pause",
  tags: ["Requests"],
  summary: "Pause multiple requests",
  body: z.object({ ids: z.array(z.string()).min(1).max(100) }),
  response: z.object({ updated: z.number(), skipped: z.number() }),
  handler: async (req, res) => {
    const { ids } = req.body;
    const result = await ctx.requestCollection.updateMany(
      {
        _id: { $in: ids },
        "run.status": { $in: ["pending", "queued"] },
        deletedAt: { $exists: false },
      },
      {
        $set: {
          "run.status": "paused",
          "run.pausedAt": new Date(),
          "run.updatedAt": new Date(),
          updatedAt: new Date(),
        },
      },
    );
    const updated = result.modifiedCount;
    res.json({ updated, skipped: ids.length - updated });
  },
});

// Bulk resume
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/bulk-resume",
  tags: ["Requests"],
  summary: "Resume multiple paused requests",
  body: z.object({ ids: z.array(z.string()).min(1).max(100) }),
  response: z.object({ updated: z.number(), skipped: z.number() }),
  handler: async (req, res) => {
    const { ids } = req.body;
    const result = await ctx.requestCollection.updateMany(
      {
        _id: { $in: ids },
        "run.status": "paused",
        deletedAt: { $exists: false },
      },
      {
        $set: {
          "run.status": "pending",
          "run.resumedAt": new Date(),
          "run.updatedAt": new Date(),
          updatedAt: new Date(),
        },
      },
    );
    const updated = result.modifiedCount;
    res.json({ updated, skipped: ids.length - updated });
  },
});

}
