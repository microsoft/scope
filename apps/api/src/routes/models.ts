// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { ListModelsQuerySchema, ModelResponseSchema } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { ModelDocument, RouteContext } from "../route-context.js";

export function registerModelsRoutes(ctx: RouteContext): void {

const ModelSyncRequestSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      providerAvailableFrom: z.string().optional(),
      providerEndOfLife: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  scannedAt: z.string(),
});

// GET /api/v1/models — list models (filterable by agentId and/or provider)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/models",
  tags: ["Models"],
  summary: "List models",
  query: ListModelsQuerySchema,
  response: z.array(ModelResponseSchema),
  handler: async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (req.query.agentId) filter.agentId = req.query.agentId;
    if (req.query.provider) filter.provider = req.query.provider;

    const models = await ctx.modelCollection
      .find(filter)
      .sort({ modelId: 1 })
      .toArray();
    res.json(models);
  },
});

// GET /api/v1/models/:id — get a single model by compound ID (agentId:modelId)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/models/:id",
  tags: ["Models"],
  summary: "Get model",
  params: z.object({ id: z.string() }),
  response: ModelResponseSchema,
  handler: async (req, res) => {
    const model = await ctx.modelCollection.findOne({ _id: req.params.id });
    if (!model) {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    res.json(model);
  },
});

// POST /api/v1/models/sync — bulk upsert with lifecycle reconciliation
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/models/sync",
  tags: ["Models"],
  summary: "Sync models from provider",
  body: ModelSyncRequestSchema,
  response: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    unchanged: z.array(z.string()),
  }),
  handler: async (req, res) => {
    const { agentId, provider, models, scannedAt } = req.body;
    const now = new Date(scannedAt);
    const scannedModelIds = new Set<string>();

    const added: string[] = [];
    const unchanged: string[] = [];

    // Upsert each scanned model
    for (const model of models) {
      if (!model.id) continue;
      scannedModelIds.add(model.id);

      const compoundId = `${agentId}:${model.id}`;
      const existing = await ctx.modelCollection.findOne({ _id: compoundId });

      if (existing) {
        const updateFields: Record<string, unknown> = { lastSeenAt: now };
        if (existing.disappearedAt) {
          updateFields.disappearedAt = undefined;
        }
        if (model.providerAvailableFrom) {
          updateFields.providerAvailableFrom = new Date(model.providerAvailableFrom);
        }
        if (model.providerEndOfLife) {
          updateFields.providerEndOfLife = new Date(model.providerEndOfLife);
        }
        if (model.metadata) {
          updateFields.metadata = model.metadata;
        }

        const unsetFields: Record<string, "" | true | 1> = {};
        if (existing.disappearedAt) {
          unsetFields.disappearedAt = "";
        }

        await ctx.modelCollection.updateOne(
          { _id: compoundId },
          {
            $set: updateFields,
            ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}),
          },
        );
        unchanged.push(model.id);
      } else {
        const doc: ModelDocument = {
          _id: compoundId,
          modelId: model.id,
          provider,
          agentId,
          firstSeenAt: now,
          lastSeenAt: now,
          ...(model.providerAvailableFrom
            ? { providerAvailableFrom: new Date(model.providerAvailableFrom) }
            : {}),
          ...(model.providerEndOfLife
            ? { providerEndOfLife: new Date(model.providerEndOfLife) }
            : {}),
          ...(model.metadata ? { metadata: model.metadata } : {}),
        };
        await ctx.modelCollection.insertOne(doc);
        added.push(model.id);
      }
    }

    // Mark disappeared models
    const existingModels = await ctx.modelCollection
      .find({ agentId, provider, disappearedAt: { $exists: false } })
      .toArray();

    const removed: string[] = [];
    for (const existing of existingModels) {
      if (!scannedModelIds.has(existing.modelId)) {
        await ctx.modelCollection.updateOne(
          { _id: existing._id },
          { $set: { disappearedAt: now } },
        );
        removed.push(existing.modelId);
      }
    }

    // Update agent's supportedModels with active (non-disappeared) models
    const activeModels = await ctx.modelCollection
      .find({ agentId, disappearedAt: { $exists: false } })
      .toArray();
    const activeModelIds = activeModels.map((m) => m.modelId).sort();

    const agent = await ctx.agentCollection.findOne({ _id: agentId });
    if (agent) {
      const needsDefault =
        !agent.defaultModel || !activeModelIds.includes(agent.defaultModel);
      let autoDefault: string | undefined;
      if (needsDefault && activeModels.length > 0) {
        const sorted = [...activeModels].sort((a, b) => {
          const dateA = a.providerAvailableFrom ?? a.firstSeenAt;
          const dateB = b.providerAvailableFrom ?? b.firstSeenAt;
          return new Date(dateB).getTime() - new Date(dateA).getTime();
        });
        autoDefault = sorted[0].modelId;
      }
      await ctx.agentCollection.updateOne(
        { _id: agentId },
        {
          $set: {
            supportedModels: activeModelIds,
            ...(autoDefault ? { defaultModel: autoDefault } : {}),
            updatedAt: new Date(),
          },
        },
      );
    }

    const report = { added, removed, unchanged };
    console.log(
      `Model sync for ${agentId}/${provider}: +${added.length} -${removed.length} =${unchanged.length}`,
    );
    res.json(report);
  },
});

}
