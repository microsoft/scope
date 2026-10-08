// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  AgentResponseSchema,
  AgentVersionSchema,
  CreateAgentInputSchema,
  PatchAgentVersionInputSchema,
  RegisterAgentVersionInputSchema,
  UpdateAgentInputSchema,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { AgentVersion, CodingAgentDocument, RouteContext } from "../route-context.js";

interface QueueOwner {
  agentId: string;
  agentVersion: string;
}

async function findActiveQueueOwner(
  agentCollection: RouteContext["agentCollection"],
  queueName: string,
  requestedTarget: QueueOwner,
  allowSameAgentTakeover = false,
): Promise<QueueOwner | undefined> {
  const agents = await agentCollection
    .find({ deletedAt: { $exists: false } })
    .toArray();

  for (const agent of agents) {
    for (const version of agent.versions ?? []) {
      if (
        version.status === "active" &&
        version.queueName?.trim() === queueName &&
        (agent._id !== requestedTarget.agentId ||
          version.agentVersion !== requestedTarget.agentVersion) &&
        (!allowSameAgentTakeover || agent._id !== requestedTarget.agentId)
      ) {
        return {
          agentId: agent._id,
          agentVersion: version.agentVersion,
        };
      }
    }
  }

  return undefined;
}

function takeOverQueue(
  versions: AgentVersion[],
  registeredVersion: AgentVersion,
): AgentVersion[] {
  let replaced = false;
  const updatedVersions = versions.map((version) => {
    if (version.agentVersion === registeredVersion.agentVersion) {
      replaced = true;
      return {
        ...registeredVersion,
        createdAt: version.createdAt,
      };
    }

    if (
      version.status === "active" &&
      version.queueName?.trim() === registeredVersion.queueName
    ) {
      return {
        ...version,
        status: "retired" as const,
      };
    }

    return version;
  });

  if (!replaced) {
    updatedVersions.push(registeredVersion);
  }

  return updatedVersions;
}

type QueueTakeoverOutcome =
  | { kind: "success"; version: AgentVersion; existed: boolean }
  | { kind: "conflict"; owner: QueueOwner; queueName: string }
  | { kind: "agent_not_found" }
  | { kind: "version_not_found" }
  | { kind: "queue_missing" }
  | { kind: "unstable" };

async function activateVersionWithQueueTakeover(
  agentCollection: RouteContext["agentCollection"],
  initialAgent: CodingAgentDocument,
  selectVersion: (agent: CodingAgentDocument) => AgentVersion | undefined,
  updatedAt?: Date,
): Promise<QueueTakeoverOutcome> {
  let currentAgent = initialAgent;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const requestedVersion = selectVersion(currentAgent);
    if (!requestedVersion) {
      return { kind: "version_not_found" };
    }

    const queueName = requestedVersion.queueName?.trim();
    if (!queueName) {
      return { kind: "queue_missing" };
    }

    const owner = await findActiveQueueOwner(
      agentCollection,
      queueName,
      {
        agentId: currentAgent._id,
        agentVersion: requestedVersion.agentVersion,
      },
      true,
    );
    if (owner) {
      return { kind: "conflict", owner, queueName };
    }

    const currentVersions = currentAgent.versions ?? [];
    const existingVersion = currentVersions.find(
      (version) => version.agentVersion === requestedVersion.agentVersion,
    );
    const activatedVersion: AgentVersion = {
      ...requestedVersion,
      status: "active",
      createdAt: existingVersion?.createdAt ?? requestedVersion.createdAt,
    };
    const nextVersions = takeOverQueue(currentVersions, activatedVersion);
    // Compare the embedded array snapshot so same-agent claims serialize
    // without requiring a multi-document transaction.
    const versionSnapshotFilter =
      currentAgent.versions === undefined
        ? { versions: { $exists: false } }
        : { versions: currentAgent.versions };
    const takeover = await agentCollection.updateOne(
      {
        _id: currentAgent._id,
        deletedAt: { $exists: false },
        ...versionSnapshotFilter,
      },
      {
        $set: {
          versions: nextVersions,
          updatedAt: updatedAt ?? new Date(),
        },
      },
    );
    if (takeover.matchedCount === 1) {
      return {
        kind: "success",
        version: activatedVersion,
        existed: existingVersion !== undefined,
      };
    }

    const refreshedAgent = await agentCollection.findOne({
      _id: currentAgent._id,
      deletedAt: { $exists: false },
    });
    if (!refreshedAgent) {
      return { kind: "agent_not_found" };
    }
    currentAgent = refreshedAgent;
  }

  return { kind: "unstable" };
}

function queueConflictError(queueName: string, owner: QueueOwner): string {
  return `Queue "${queueName}" is already assigned to ${owner.agentId}@${owner.agentVersion}`;
}

export function registerAgentsRoutes(ctx: RouteContext): void {

// List all agents
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/agents",
  tags: ["Agents"],
  summary: "List agents",
  query: z.object({
    modelProvider: z.string().optional(),
    includeDeleted: z.enum(["true", "false"]).optional(),
  }),
  response: z.array(AgentResponseSchema),
  handler: async (req, res, next) => {
    try {
      const modelProvider = req.query?.modelProvider as string | undefined;
      const includeDeleted = req.query?.includeDeleted === "true";
      const filter: Record<string, unknown> = includeDeleted
        ? {}
        : { deletedAt: { $exists: false } };
      if (modelProvider) {
        filter.modelProvider = modelProvider;
      }
      const agents = await ctx.agentCollection
        .find(filter)
        .toArray();
      // Sort in JS for CosmosDB compatibility
      agents.sort((a, b) => a._id.localeCompare(b._id));
      res.json(agents.map((a) => ({ ...a, id: a._id })));
    } catch (error) {
      next(error);
    }
  },
});

// Get a single agent
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/agents/:id",
  tags: ["Agents"],
  summary: "Get agent",
  params: z.object({ id: z.string() }),
  query: z.object({ includeDeleted: z.enum(["true", "false"]).optional() }),
  response: AgentResponseSchema,
  errorResponses: {
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const includeDeleted = req.query?.includeDeleted === "true";
      const agent = await ctx.agentCollection.findOne({
        _id: id,
        ...(includeDeleted ? {} : { deletedAt: { $exists: false } }),
      });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json({ ...agent, id: agent._id });
    } catch (error) {
      next(error);
    }
  },
});

// Create or upsert an agent (idempotent — used by seed jobs)
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/agents",
  tags: ["Agents"],
  summary: "Create or update agent (upsert)",
  body: CreateAgentInputSchema,
  response: AgentResponseSchema,
  errorResponses: {
    400: { description: "Validation error" },
    409: { description: "Restored agent versions conflict with an active queue owner" },
  },
  handler: async (req, res, next) => {
    try {
      const { _id, name, description, modelProvider, supportedModels, defaultModel, available, capabilities } = req.body;

      if (!_id || typeof _id !== "string") {
        res.status(400).json({ error: "_id is required and must be a string" });
        return;
      }
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required and must be a string" });
        return;
      }
      // supportedModels is optional — if provided, must be a string array
      if (supportedModels !== undefined && (!Array.isArray(supportedModels) || !supportedModels.every((m: unknown) => typeof m === "string"))) {
        res.status(400).json({ error: "supportedModels must be an array of strings" });
        return;
      }
      if (defaultModel !== undefined && typeof defaultModel !== "string") {
        res.status(400).json({ error: "defaultModel must be a string" });
        return;
      }
      if (defaultModel && supportedModels && supportedModels.length > 0 && !supportedModels.includes(defaultModel)) {
        res.status(400).json({ error: "defaultModel must be one of supportedModels" });
        return;
      }

      const now = new Date();
      const existing = await ctx.agentCollection.findOne({ _id });

      if (existing) {
        if (existing.deletedAt) {
          const restoredTargetByQueue = new Map<string, string>();
          const restoredQueueByTarget = new Map<string, string>();
          for (const version of existing.versions ?? []) {
            const queueName = version.queueName?.trim();
            if (version.status !== "active" || !queueName) continue;
            const existingVersion = restoredTargetByQueue.get(queueName);
            const existingQueue = restoredQueueByTarget.get(version.agentVersion);
            if (
              (existingVersion && existingVersion !== version.agentVersion) ||
              (existingQueue && existingQueue !== queueName)
            ) {
              res.status(409).json({
                error: `Restored agent has conflicting active queue assignments involving "${queueName}"`,
              });
              return;
            }
            restoredTargetByQueue.set(queueName, version.agentVersion);
            restoredQueueByTarget.set(version.agentVersion, queueName);
            const owner = await findActiveQueueOwner(
              ctx.agentCollection,
              queueName,
              { agentId: _id, agentVersion: version.agentVersion },
            );
            if (owner) {
              res.status(409).json({ error: queueConflictError(queueName, owner) });
              return;
            }
          }
        }

        // Upsert: update existing (un-delete if soft-deleted)
        // Only update supportedModels if explicitly provided — prevents registration
        // jobs from wiping models set by the scanner
        const effectiveModels = supportedModels ?? existing.supportedModels;
        await ctx.agentCollection.updateOne(
          { _id },
          {
            $set: {
              name,
              ...(description !== undefined ? { description } : {}),
              ...(modelProvider !== undefined ? { modelProvider } : {}),
              ...(supportedModels !== undefined ? { supportedModels } : {}),
              ...(defaultModel !== undefined ? { defaultModel } : {}),
              ...(available !== undefined ? { available } : {}),
              ...(capabilities !== undefined ? { capabilities } : {}),
              updatedAt: now,
            },
            $unset: { deletedAt: "" },
          }
        );
        const updated = await ctx.agentCollection.findOne({ _id });
        res.json({ ...updated, id: updated!._id });
      } else {
        // Create new — default to empty supportedModels if not provided
        const agentDoc: CodingAgentDocument = {
          _id,
          name,
          ...(description ? { description } : {}),
          ...(modelProvider ? { modelProvider } : {}),
          supportedModels: supportedModels ?? [],
          ...(defaultModel ? { defaultModel } : {}),
          ...(available !== undefined ? { available } : {}),
          ...(capabilities ? { capabilities } : {}),
          createdAt: now,
        };
        await ctx.agentCollection.insertOne(agentDoc);
        res.status(201).json({ ...agentDoc, id: agentDoc._id });
      }
    } catch (error) {
      next(error);
    }
  },
});

// Update an agent
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/agents/:id",
  tags: ["Agents"],
  summary: "Update agent",
  params: z.object({ id: z.string() }),
  body: UpdateAgentInputSchema,
  response: AgentResponseSchema,
  errorResponses: {
    400: { description: "Validation error" },
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { name, description, supportedModels, defaultModel, available, capabilities } = req.body;

      const existing = await ctx.agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const updateFields: Record<string, unknown> = { updatedAt: new Date() };
      if (name !== undefined) updateFields.name = name;
      if (description !== undefined) updateFields.description = description;
      if (supportedModels !== undefined) {
        if (!Array.isArray(supportedModels) || !supportedModels.every((m: unknown) => typeof m === "string")) {
          res.status(400).json({ error: "supportedModels must be an array of strings" });
          return;
        }
        updateFields.supportedModels = supportedModels;
      }
      if (defaultModel !== undefined) {
        const models = (supportedModels as string[] | undefined) || existing.supportedModels;
        if (defaultModel && models.length > 0 && !models.includes(defaultModel)) {
          res.status(400).json({ error: "defaultModel must be one of supportedModels" });
          return;
        }
        updateFields.defaultModel = defaultModel;
      }
      if (available !== undefined) updateFields.available = available;
      if (capabilities !== undefined) updateFields.capabilities = capabilities;

      await ctx.agentCollection.updateOne({ _id: id }, { $set: updateFields });

      const updated = await ctx.agentCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Soft-delete an agent
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/agents/:id",
  tags: ["Agents"],
  summary: "Delete agent",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  errorResponses: {
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;

      const existing = await ctx.agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      await ctx.agentCollection.updateOne(
        { _id: id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } }
      );

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

// ============================================================
// Agent Versions routes (/api/v1/agents/:id/versions) (apiRoute)
// ============================================================

// List versions for an agent (optional ?status=active filter)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/agents/:id/versions",
  tags: ["Agents"],
  summary: "List agent versions",
  params: z.object({ id: z.string() }),
  query: z.object({ status: z.string().optional() }),
  response: z.array(AgentVersionSchema),
  errorResponses: {
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status } = req.query;

      const agent = await ctx.agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      let versions = agent.versions ?? [];
      if (status && typeof status === "string") {
        versions = versions.filter((v: AgentVersion) => v.status === status);
      }

      res.json(versions);
    } catch (error) {
      next(error);
    }
  },
});

// Register/upsert an agent version (keyed by agentVersion)
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/agents/:id/versions",
  tags: ["Agents"],
  summary: "Register agent version (upsert)",
  params: z.object({ id: z.string() }),
  body: RegisterAgentVersionInputSchema,
  response: AgentVersionSchema,
  errorResponses: {
    400: { description: "Validation error" },
    409: { description: "Queue is assigned to another agent" },
    404: { description: "Agent not found" },
    503: { description: "Concurrent registration did not stabilize" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { agentVersion, workerVersion, components, gitCommit, buildTime, imageTag, queueName } = req.body;

      // Validate required fields
      if (!agentVersion || typeof agentVersion !== "string") {
        res.status(400).json({ error: "agentVersion is required and must be a string" });
        return;
      }
      if (!workerVersion || typeof workerVersion !== "string") {
        res.status(400).json({ error: "workerVersion is required and must be a string" });
        return;
      }
      if (!components || typeof components !== "object" || Array.isArray(components)) {
        res.status(400).json({ error: "components is required and must be an object" });
        return;
      }
      if (!gitCommit || typeof gitCommit !== "string") {
        res.status(400).json({ error: "gitCommit is required and must be a string" });
        return;
      }
      if (!buildTime || typeof buildTime !== "string") {
        res.status(400).json({ error: "buildTime is required and must be a string" });
        return;
      }
      if (!imageTag || typeof imageTag !== "string") {
        res.status(400).json({ error: "imageTag is required and must be a string" });
        return;
      }
      if (!queueName || typeof queueName !== "string" || !queueName.trim()) {
        res.status(400).json({ error: "queueName is required and must be a string" });
        return;
      }
      const normalizedQueueName = queueName.trim();

      const agent = await ctx.agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const now = new Date();
      const outcome = await activateVersionWithQueueTakeover(
        ctx.agentCollection,
        agent,
        () => ({
          agentVersion,
          workerVersion,
          components,
          gitCommit,
          buildTime,
          imageTag,
          queueName: normalizedQueueName,
          status: "active",
          createdAt: now,
        }),
        now,
      );
      if (outcome.kind === "success") {
        res.status(outcome.existed ? 200 : 201).json(outcome.version);
        return;
      }
      if (outcome.kind === "conflict") {
        res
          .status(409)
          .json({ error: queueConflictError(outcome.queueName, outcome.owner) });
        return;
      }
      if (outcome.kind === "agent_not_found") {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (outcome.kind === "queue_missing") {
        res.status(400).json({ error: "Active version must have a queueName" });
        return;
      }
      if (outcome.kind === "version_not_found") {
        res.status(404).json({ error: "Version not found" });
        return;
      }

      res.status(503).json({
        error: "Agent versions changed concurrently; retry registration",
      });
    } catch (error) {
      next(error);
    }
  },
});

// Update an agent version's status (e.g. retire)
apiRoute(ctx.app, ctx.registry, {
  method: "patch",
  path: "/api/v1/agents/:id/versions/:agentVersion",
  tags: ["Agents"],
  summary: "Patch agent version",
  params: z.object({ id: z.string(), agentVersion: z.string() }),
  body: PatchAgentVersionInputSchema,
  response: AgentVersionSchema,
  errorResponses: {
    400: { description: "Invalid status value" },
    409: { description: "Queue is assigned to another agent" },
    404: { description: "Agent or version not found" },
    503: { description: "Concurrent activation did not stabilize" },
  },
  handler: async (req, res, next) => {
    try {
      const { id, agentVersion } = req.params;
      const { status } = req.body;

      if (!status || !(["active", "retired"] as string[]).includes(status)) {
        res.status(400).json({ error: "status must be 'active' or 'retired'" });
        return;
      }

      const agent = await ctx.agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const version = (agent.versions ?? []).find((v: AgentVersion) => v.agentVersion === agentVersion);
      if (!version) {
        res.status(404).json({ error: "Version not found" });
        return;
      }

      if (status === "active") {
        const outcome = await activateVersionWithQueueTakeover(
          ctx.agentCollection,
          agent,
          (currentAgent) =>
            (currentAgent.versions ?? []).find(
              (candidate: AgentVersion) =>
                candidate.agentVersion === agentVersion,
            ),
        );
        if (outcome.kind === "success") {
          res.json(outcome.version);
          return;
        }
        if (
          outcome.kind === "agent_not_found" ||
          outcome.kind === "version_not_found"
        ) {
          res.status(404).json({
            error:
              outcome.kind === "agent_not_found"
                ? "Agent not found"
                : "Version not found",
          });
          return;
        }
        if (outcome.kind === "queue_missing") {
          res.status(400).json({ error: "Active version must have a queueName" });
          return;
        }
        if (outcome.kind === "conflict") {
          res.status(409).json({
            error: queueConflictError(outcome.queueName, outcome.owner),
          });
          return;
        }

        res.status(503).json({
          error: "Agent versions changed concurrently; retry activation",
        });
        return;
      }

      await ctx.agentCollection.updateOne(
        { _id: id, "versions.agentVersion": agentVersion },
        {
          $set: {
            "versions.$.status": status,
            updatedAt: new Date(),
          },
        }
      );

      res.json({ ...version, status });
    } catch (error) {
      next(error);
    }
  },
});

}
