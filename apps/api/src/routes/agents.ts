// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { AgentResponseSchema, AgentVersionSchema, CreateAgentInputSchema, PatchAgentVersionInputSchema, RegisterAgentVersionInputSchema, UpdateAgentInputSchema } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { AgentVersion, CodingAgentDocument, RouteContext } from "../route-context.js";

export function registerAgentsRoutes(ctx: RouteContext): void {

// List all agents
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/agents",
  tags: ["Agents"],
  summary: "List agents",
  query: z.object({ modelProvider: z.string().optional() }),
  response: z.array(AgentResponseSchema),
  handler: async (req, res, next) => {
    try {
      const modelProvider = req.query?.modelProvider as string | undefined;
      const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
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
  response: AgentResponseSchema,
  errorResponses: {
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const agent = await ctx.agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
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
  },
  handler: async (req, res, next) => {
    try {
      const { _id, name, description, modelProvider, supportedModels, defaultModel, available } = req.body;

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
      const { name, description, supportedModels, defaultModel, available } = req.body;

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
    404: { description: "Agent not found" },
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
      if (!queueName || typeof queueName !== "string") {
        res.status(400).json({ error: "queueName is required and must be a string" });
        return;
      }

      const agent = await ctx.agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const now = new Date();
      const versionEntry: AgentVersion = {
        agentVersion,
        workerVersion,
        components,
        gitCommit,
        buildTime,
        imageTag,
        queueName,
        status: "active",
        createdAt: now,
      };

      // Upsert: update existing entry with same agentVersion or push new
      const existing = (agent.versions ?? []).find((v: AgentVersion) => v.agentVersion === agentVersion);
      if (existing) {
        await ctx.agentCollection.updateOne(
          { _id: id, "versions.agentVersion": agentVersion },
          {
            $set: {
              "versions.$.workerVersion": workerVersion,
              "versions.$.components": components,
              "versions.$.gitCommit": gitCommit,
              "versions.$.buildTime": buildTime,
              "versions.$.imageTag": imageTag,
              "versions.$.queueName": queueName,
              "versions.$.status": "active",
              updatedAt: now,
            },
          }
        );
      } else {
        await ctx.agentCollection.updateOne(
          { _id: id },
          {
            $push: { versions: versionEntry },
            $set: { updatedAt: now },
          }
        );
      }

      res.status(existing ? 200 : 201).json(versionEntry);
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
    404: { description: "Agent or version not found" },
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
