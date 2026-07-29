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
import { BulkResubmitInputSchema, CreateRequestInputSchema, ListRequestsQuerySchema, MULTI_TURN_DEFAULTS, PaginatedRunGroupsResponseSchema, PaginatedRunsResponseSchema, ReportResponseSchema, RequestResponseSchema, RunStateSchema, decodeCursor, encodeCursor, resolveAgentVersion } from "@scope/core";
import { ExtensionClient, parseExtensionSpec } from "@scope/platform";
import type { ProfileDocument, ProfileVersionDocument } from "@scope/core";
import { apiRoute } from "../../openapi/api-route.js";
import { VALID_WORKERS } from "../../route-context.js";
import type {
  ExtensionDocument,
  McpServerDocument,
  RequestDocument,
  RouteContext,
  WorkerType,
} from "../../route-context.js";
import { computeAnalysis } from "../../analysis.js";
import type { AnalysisResponse, AnalyzableRun } from "../../analysis.js";
import { parseStateKey } from "../../criteria-mdp.js";
import { buildGroupingPipeline } from "../../grouping.js";
import { resolveSkillSpecs } from "../../utils/skill-helpers.js";
import {
  packRunIntoTar,
} from "../../archive-har.js";
import { insertHistoricalRun, listHistoricalRuns, getHistoricalRun } from "../../runs-repo.js";
import type { RunState } from "@scope/core";

export function registerRequestsRoutes(ctx: RouteContext): void {

const upload = multer({ dest: tmpdir() });

// Submit a request
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests",
  tags: ["Requests"],
  summary: "Submit request(s)",
  body: CreateRequestInputSchema.extend({
    count: z.number().min(1).max(10).default(1),
    promptFeatureExtractionId: z.string().optional(),
    skills: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    agentVersion: z.string().optional(),
  }),
  response: z.union([RequestResponseSchema, z.array(RequestResponseSchema)]),
  successStatus: 201,
  handler: async (req, res) => {
    const { scenario: scenarioObj, persona: personaObj, maxIterations, personaInstructions, count = 1, promptFeatureExtractionId, model: requestedModel, mcpServers: mcpServerSlugs, skills: skillSlugs, extensions: extensionIds, agentVersion: requestedAgentVersion, profileId: requestedProfileId, priority: requestedPriority } = req.body;
    let worker = req.query.worker as string;

    // --- Profile resolution: if profileId is provided, resolve the version and use its values ---
    let profileId: string | undefined;
    let profileVersionId: string | undefined;
    let profileVersion: ProfileVersionDocument | null = null;
    if (requestedProfileId) {
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
        version: profile.latestVersion,
      });
      if (!profileVersion) {
        res.status(404).json({ error: `Profile version not found for profile: ${requestedProfileId}` });
        return;
      }
      profileId = profile._id;
      profileVersionId = profileVersion._id;

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
      if (conflicts.length > 0) {
        res.status(400).json({
          error: `Profile "${profileId}" controls these fields. Either omit them or match the profile values.`,
          conflicts,
        });
        return;
      }

      // Profile fields take precedence
      worker = profileVersion.workerType;
    }

    // Effective values: profile overrides client inputs for controlled fields
    const effectiveModel = profileVersion ? profileVersion.model : requestedModel;
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
        validWorkers: VALID_WORKERS,
        example: "/api/v1/requests?worker=worker-1"
      });
      return;
    }

    if (!VALID_WORKERS.includes(worker as WorkerType)) {
      res.status(400).json({ 
        error: `Invalid worker: ${worker}`,
        validWorkers: VALID_WORKERS
      });
      return;
    }

    // Check if the worker (agent) is available for new submissions
    const workerAgent = await ctx.agentCollection.findOne({ _id: worker, deletedAt: { $exists: false } });
    if (workerAgent && workerAgent.available === false) {
      res.status(400).json({
        error: `Worker "${worker}" is not available for new submissions`,
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

    // Validate count if provided
    if (typeof count !== "number" || count < 1 || count > 10) {
      res.status(400).json({ error: "count must be a number between 1 and 10" });
      return;
    }

    const workerType = worker as WorkerType;

    // Resolve model: validate against agent's supportedModels if available
    let model: string | undefined = effectiveModel;
    const agentDoc = await ctx.agentCollection.findOne({ _id: workerType, deletedAt: { $exists: false } });
    if (agentDoc && agentDoc.supportedModels.length > 0) {
      if (model && !agentDoc.supportedModels.includes(model)) {
        res.status(400).json({
          error: `Invalid model "${model}" for agent "${workerType}"`,
          supportedModels: agentDoc.supportedModels,
        });
        return;
      }
      if (!model && agentDoc.defaultModel) {
        model = agentDoc.defaultModel;
      }
      if (!model) {
        res.status(400).json({
          error: `model is required for agent "${workerType}". Select one of supportedModels or set a defaultModel on the agent.`,
          supportedModels: agentDoc.supportedModels,
        });
        return;
      }
    }

    // Resolve agent version: explicit selection or latest active
    let resolvedAgentVersion: string | undefined;
    if (agentDoc) {
      const versionResult = resolveAgentVersion(agentDoc.versions, requestedAgentVersion);
      if ("error" in versionResult) {
        res.status(400).json({
          error: `${versionResult.error} for agent "${workerType}"`,
          activeVersions: versionResult.activeVersions,
        });
        return;
      }
      resolvedAgentVersion = versionResult.agentVersion;
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
          .find({ _id: { $in: effectiveMcpServers }, deletedAt: { $exists: false } })
          .toArray();
        const existingSlugs = new Set(existingServers.map((s: McpServerDocument) => s._id));
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
        const result = await resolveSkillSpecs(effectiveSkills, ctx);
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
        const existingExtensions = await ctx.extensionCollection
          .find({ _id: { $in: bareIds }, deletedAt: { $exists: false } })
          .toArray();
        const existingIds = new Set(existingExtensions.map((e: ExtensionDocument) => e._id));
        const missingIds = bareIds.filter((id: string) => !existingIds.has(id));
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
    const taskPrompt = await ctx.taskPromptStore.findOrCreate(scenario.task);
    const taskPromptId = taskPrompt._id;

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
          scenario,
          workerType,
          taskPromptId,
          createdAt: new Date(),
          priority: requestedPriority ?? 0,
          ...(model ? { model } : {}),
          ...(maxIterations ? { maxIterations } : {}),
          ...(personaInstructions ? { personaInstructions } : {}),
          ...(personaObj ? { persona: personaObj } : {}),
          ...(promptFeatureExtractionId ? { promptFeatureExtractionId } : {}),
          ...(validatedMcpServers ? { mcpServers: validatedMcpServers } : {}),
          ...(resolvedSkillRevisions ? { skillRevisions: resolvedSkillRevisions } : {}),
          ...(validatedExtensions ? { extensions: validatedExtensions } : {}),
          ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
          ...(profileId ? { profileId } : {}),
          ...(profileVersionId ? { profileVersionId } : {}),
          submissionId,
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
        ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
        status: "pending",
        mode,
        message: `${count} requests submitted successfully`,
        scenario,
        ...(maxIterations ? { maxIterations } : {}),
      });
      return;
    }

    // Single run (count === 1) - original behavior
    const requestId = uuidv4();
    const runId = uuidv4();

    // Create request document
    const requestDoc: RequestDocument = {
      _id: requestId,
      scenario,
      workerType,
      taskPromptId,
      createdAt: new Date(),
      priority: requestedPriority ?? 0,
      ...(model ? { model } : {}),
      ...(maxIterations ? { maxIterations } : {}),
      ...(personaInstructions ? { personaInstructions } : {}),
      ...(personaObj ? { persona: personaObj } : {}),
      ...(promptFeatureExtractionId ? { promptFeatureExtractionId } : {}),
      ...(validatedMcpServers ? { mcpServers: validatedMcpServers } : {}),
      ...(resolvedSkillRevisions ? { skillRevisions: resolvedSkillRevisions } : {}),
      ...(validatedExtensions ? { extensions: validatedExtensions } : {}),
      ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
      ...(profileId ? { profileId } : {}),
      ...(profileVersionId ? { profileVersionId } : {}),
      submissionId,
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
      ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
      status: requestDoc.run?.status ?? "pending",
      mode,
      message: "Request submitted successfully",
      scenario,
      ...(maxIterations ? { maxIterations } : {}),
    });
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
  query: ListRequestsQuerySchema,
  response: z.union([PaginatedRunsResponseSchema, PaginatedRunGroupsResponseSchema]),
  handler: async (req, res) => {
    const workerFilter = req.query.worker as string;
    const taskPromptIdFilter = req.query.taskPromptId as string;
    const criteriaFilter = req.query.criteria as string;
    const submissionIdFilter = req.query.submissionId as string;
    const profileIdFilter = req.query.profileId as string;
    const statusFilter = req.query.status as string;
    const outcomeFilter = req.query.outcome as string;
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

    if (afterParam && beforeParam) {
      res.status(400).json({ error: "Cannot specify both 'after' and 'before'" });
      return;
    }
    if (lastParam && (afterParam || beforeParam)) {
      res.status(400).json({ error: "Cannot combine 'last=true' with 'after' or 'before'" });
      return;
    }
    
    const filter: Record<string, unknown> = {};
    if (workerFilter && VALID_WORKERS.includes(workerFilter as WorkerType)) {
      filter.workerType = workerFilter;
    }
    if (taskPromptIdFilter) {
      filter.taskPromptId = taskPromptIdFilter;
    }
    if (statusFilter) {
      // Post run-retry-attempts: per-attempt state lives at run.status.
      filter["run.status"] = statusFilter;
    }
    if (outcomeFilter) {
      filter["run.outcome"] = outcomeFilter;
    }
    if (profileIdFilter) {
      filter.profileId = profileIdFilter;
    }
    if (submissionIdFilter) {
      // Prefix-based matching: allow filtering by partial submission ID
      filter.submissionId = { $regex: `^${submissionIdFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
    }
    if (!includeDeleted) {
      filter.deletedAt = { $exists: false };
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
      filter.maxIterations = { [op]: n };
    }
    if (turnsFilterRaw !== undefined && turnsFilterRaw !== "") {
      const n = Number(turnsFilterRaw);
      const op = OP_MAP[turnsOpFilter];
      if (!Number.isFinite(n) || n < 0 || !op) {
        res.status(400).json({ error: "Invalid turns or turnsOp" });
        return;
      }
      filter.$expr = { [op]: [{ $size: { $ifNull: ["$run.turns", []] } }, n] };
    }

    // Filter by MDP criteria state vector (e.g. "has_azure:0|has_cloud:1")
    // Matches runs whose LAST turn contains criteria results matching every
    // criterion in the state vector.
    if (criteriaFilter) {
      const criteriaStates = parseStateKey(criteriaFilter);
      if (criteriaStates.length > 0) {
        filter.$and = criteriaStates.map((cs) => ({
          "turns": {
            $elemMatch: {
              "criteriaResults": {
                $elemMatch: {
                  criterionId: cs.id,
                  passed: cs.passed,
                },
              },
            },
          },
        }));
      }
    }

    // O(1) estimated total from collection metadata (unfiltered)
    const estimatedTotal = await ctx.requestCollection.estimatedDocumentCount();

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

    // Flat mode: paginated runs with cursor on { createdAt, _id }
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

    // Build cursor filter for seek-based pagination
    const cursorFilter = { ...filter };
    let sort: Record<string, 1 | -1> = { createdAt: -1, _id: -1 };
    let needsReverse = false;

    if (lastParam) {
      // Jump to the last page by querying from oldest first, then reverse for normal UI ordering.
      sort = { createdAt: 1, _id: 1 };
      needsReverse = true;
    } else if (afterCursor) {
      // Forward: items after this cursor (older, since sort is descending)
      cursorFilter.$or = [
        { createdAt: { $lt: new Date(afterCursor.createdAt) } },
        { createdAt: new Date(afterCursor.createdAt), _id: { $lt: afterCursor.id } },
      ];
    } else if (beforeCursor) {
      // Backward: flip sort, get items before cursor, then reverse
      sort = { createdAt: 1, _id: 1 };
      needsReverse = true;
      cursorFilter.$or = [
        { createdAt: { $gt: new Date(beforeCursor.createdAt) } },
        { createdAt: new Date(beforeCursor.createdAt), _id: { $gt: beforeCursor.id } },
      ];
    }

    const resources = await ctx.requestCollection.find(cursorFilter).sort(sort).limit(limit).toArray();

    if (needsReverse) {
      resources.reverse();
    }

    const data = resources.map((r) => ({ ...r, id: r._id }));

    // Enrich `processing` runs with the latest liveness heartbeat from
    // Redis (single MGET; heartbeats live there, not Mongo).
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

    // Build cursors from first and last items
    const first = data[0];
    const last = data[data.length - 1];
    const firstCreatedAt = new Date(first.createdAt).toISOString();
    const firstId = String(first._id);
    const lastCreatedAt = new Date(last.createdAt).toISOString();
    const lastId = String(last._id);

    // Check if there are more results in each direction
    const [hasMoreAfter, hasMoreBefore] = lastParam
      ? await Promise.all([
          Promise.resolve([] as Record<string, unknown>[]),
          ctx.requestCollection.find({
            ...filter,
            $or: [
              { createdAt: { $gt: new Date(firstCreatedAt) } },
              { createdAt: new Date(firstCreatedAt), _id: { $gt: firstId } },
            ],
          }).sort({ createdAt: 1, _id: 1 }).limit(1).toArray(),
        ])
      : await Promise.all([
          ctx.requestCollection.find({
            ...filter,
            $or: [
              { createdAt: { $lt: new Date(lastCreatedAt) } },
              { createdAt: new Date(lastCreatedAt), _id: { $lt: lastId } },
            ],
          }).sort({ createdAt: -1, _id: -1 }).limit(1).toArray(),
          ctx.requestCollection.find({
            ...filter,
            $or: [
              { createdAt: { $gt: new Date(firstCreatedAt) } },
              { createdAt: new Date(firstCreatedAt), _id: { $gt: firstId } },
            ],
          }).sort({ createdAt: 1, _id: 1 }).limit(1).toArray(),
        ]);

    res.json({
      data,
      limit,
      estimatedTotal,
      cursors: {
        next: lastParam ? null : hasMoreAfter.length > 0 ? encodeCursor({ createdAt: lastCreatedAt, id: lastId }) : null,
        prev: hasMoreBefore.length > 0 ? encodeCursor({ createdAt: firstCreatedAt, id: firstId }) : null,
      },
    });
  },
});

// Analysis endpoint - compute pass@k, success@T, and iteration stats
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/analysis",
  tags: ["Requests"],
  summary: "Compute pass@k / success@T metrics",
  query: z.object({
    worker: z.string().optional(),
    taskPromptId: z.string().optional(),
    criteria: z.string().optional(),
    submissionId: z.string().optional(),
    k: z.string().optional(),
  }),
  response: z.object({}).passthrough().describe("Analysis metrics"),
  handler: async (req, res) => {
    // Parse k values from query string (default: 1,2,5)
    const kParam = (req.query.k as string) || "1,2,5";
    const kValues = kParam.split(",").map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v) && v > 0);

    // Parse criteria filter from query string (comma-separated criterion IDs)
    const criteriaParam = req.query.criteria as string | undefined;
    const selectedCriteria = criteriaParam
      ? criteriaParam.split(",").map(c => c.trim()).filter(Boolean)
      : undefined;

    // Fetch all done runs (exclude pending/processing, exclude deleted).
    // Per-attempt state lives at run.* (run-retry-attempts).
    const runs = await ctx.requestCollection
      .find({
        "run.status": "done",
        deletedAt: { $exists: false },
      })
      .project({
        _id: 1,
        scenario: 1,
        workerType: 1,
        run: 1,
      })
      .toArray();

    // Transform to AnalyzableRun format
    const analyzableRuns: AnalyzableRun[] = runs.map(r => ({
      scenario: r.scenario,
      workerType: r.workerType,
      status: r.run?.status ?? "done",
      outcome: r.run?.outcome,
      turns: r.run?.turns,
    }));

    const analysis: AnalysisResponse = computeAnalysis(analyzableRuns, kValues, selectedCriteria);
    res.json(analysis);
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

    // Validate workerType override against known workers
    if (overrides?.workerType && !VALID_WORKERS.includes(overrides.workerType as WorkerType)) {
      res.status(400).json({ error: `Invalid workerType override: ${overrides.workerType}` });
      return;
    }

    // Check if the overridden worker is available for new submissions
    if (overrides?.workerType) {
      const overrideAgent = await ctx.agentCollection.findOne({ _id: overrides.workerType, deletedAt: { $exists: false } });
      if (overrideAgent && overrideAgent.available === false) {
        res.status(400).json({ error: `Worker "${overrides.workerType}" is not available for new submissions` });
        return;
      }
    }

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
      overrideProfileVersionId = overrideProfileVersion._id;

      // Reject individual overrides that conflict with the profile's controlled fields
      const conflicts: string[] = [];
      if (overrides?.workerType && overrides.workerType !== overrideProfileVersion.workerType) {
        conflicts.push(`workerType: sent "${overrides.workerType}", profile requires "${overrideProfileVersion.workerType}"`);
      }
      if (overrides?.model !== undefined && overrides.model !== overrideProfileVersion.model) {
        conflicts.push(`model: sent "${overrides.model}", profile requires "${overrideProfileVersion.model}"`);
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
            activeProfileVersion = await ctx.profileVersionCollection.findOne({ _id: original.profileVersionId });
          }
        }

        // When a profile is active, its values take precedence over individual overrides
        // for the fields it controls: workerType, model, mcpServers, skillRevisions, extensions
        const effectiveWorkerType = (activeProfileVersion
          ? activeProfileVersion.workerType
          : (overrides?.workerType ?? original.workerType)) as WorkerType;
        const effectiveModel = activeProfileVersion
          ? activeProfileVersion.model
          : (overrides?.model !== undefined ? overrides.model : original.model);
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
          const result = await resolveSkillSpecs(effectiveSkillRevisions, ctx);
          if (result.error) {
            res.status(422).json({ error: `Skill resolution failed during resubmit: ${result.error}` });
            return;
          }
          resolvedSkillRevisions = result.refs ?? null;
        }
        const effectiveExtensions = activeProfileVersion
          ? (activeProfileVersion.extensions ?? null)
          : (overrides?.extensions !== undefined ? overrides.extensions : original.extensions);
        // Strip extensions for non-vscode workers (they don't support VS Code extensions)
        const isVscodeWorker = effectiveWorkerType.includes("vscode");

        // Resolve agent version for re-submitted run (latest active for the effective worker)
        let resolvedAgentVersion: string | undefined;
        const agentDoc = await ctx.agentCollection.findOne({ _id: effectiveWorkerType, deletedAt: { $exists: false } });
        if (agentDoc) {
          const versionResult = resolveAgentVersion(agentDoc.versions, undefined);
          if (!("error" in versionResult)) {
            resolvedAgentVersion = versionResult.agentVersion;
          }
        }

        const newDoc: RequestDocument = {
          _id: requestId,
          scenario: original.scenario,
          workerType: effectiveWorkerType,
          createdAt: new Date(),
          priority: original.priority ?? 0,
          ...(effectiveMaxIterations ? { maxIterations: effectiveMaxIterations } : {}),
          ...(original.personaInstructions ? { personaInstructions: original.personaInstructions } : {}),
          ...(original.persona ? { persona: original.persona } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(effectiveMcpServers && effectiveMcpServers.length > 0 ? { mcpServers: effectiveMcpServers } : {}),
          ...(resolvedSkillRevisions && resolvedSkillRevisions.length > 0 ? { skillRevisions: resolvedSkillRevisions } : {}),
          ...(isVscodeWorker && effectiveExtensions && effectiveExtensions.length > 0 ? { extensions: effectiveExtensions } : {}),
          ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
          ...(original.taskPromptId ? { taskPromptId: original.taskPromptId } : {}),
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
          ...(effectiveProfileVersionId ? { profileVersionId: effectiveProfileVersionId } : {}),
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
  const taskPrompt = await ctx.taskPromptStore.findOrCreate(runDoc.scenario.task);
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
        imported.push(await finalizePendingRun(prefix, run, blobServiceClient));
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
  response: RequestResponseSchema,
  rawResponse: true,
  successStatus: 201,
  handler: async (req, res) => {
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
        result = await streamArchiveImport(stream, buildBlobServiceClient());
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
  handler: async (req, res) => {
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
        result = await streamArchiveImport(stream, buildBlobServiceClient());
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
        await insertHistoricalRun({ runsCollection: ctx.runsCollection }, id, runToDemote);
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
        { $set: { run: newRun, updatedAt: new Date() } },
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
      await insertHistoricalRun({ runsCollection: ctx.runsCollection }, id, runToDemote);
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
