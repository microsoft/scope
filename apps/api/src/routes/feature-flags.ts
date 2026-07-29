// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { FeatureFlagResponseSchema, UpdateFeatureFlagInputSchema } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";

export function registerFeatureFlagRoutes(ctx: RouteContext): void {
  const { app, registry } = ctx;

  // GET /api/v1/feature-flags — list all feature flags
  apiRoute(app, registry, {
    method: "get",
    path: "/api/v1/feature-flags",
    tags: ["Feature Flags"],
    summary: "List feature flags",
    response: z.array(FeatureFlagResponseSchema),
    handler: async (_req, res) => {
      const flags = await ctx.featureFlagCollection.find({}).toArray();
      res.json(flags);
    },
  });

  // PUT /api/v1/feature-flags/:key — update a feature flag
  apiRoute(app, registry, {
    method: "put",
    path: "/api/v1/feature-flags/:key",
    tags: ["Feature Flags"],
    summary: "Update feature flag",
    params: z.object({ key: z.string() }),
    body: UpdateFeatureFlagInputSchema,
    response: FeatureFlagResponseSchema,
    handler: async (req, res) => {
      const result = await ctx.featureFlagCollection.findOneAndUpdate(
        { key: req.params.key },
        { $set: { enabled: req.body.enabled, updatedAt: new Date() } },
        { returnDocument: "after" },
      );

      if (!result) {
        res.status(404).json({ error: `Feature flag '${req.params.key}' not found` });
        return;
      }

      res.json(result);
    },
  });
}
