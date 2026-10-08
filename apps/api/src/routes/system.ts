// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { checkMigrations } from "db-migrations/check-migrations";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";

export function registerSystemRoutes(ctx: RouteContext): void {

// Health check endpoint (liveness probe — always returns 200)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Liveness probe",
  response: z.object({ status: z.string(), version: z.string() }),
  handler: async (_req, res) => {
    res.json({ status: "healthy", version: (process.env.GIT_COMMIT || "development") });
  },
});

// Readiness probe — returns 200 only when all required DB migrations have
// been applied. Kubernetes will withhold traffic until this returns 200.
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/ready",
  tags: ["Health"],
  summary: "Readiness probe",
  response: z.object({ status: z.string(), migrations: z.any() }),
  errorResponses: {
    503: { description: "Service is not ready" },
  },
  handler: async (_req, res) => {
    try {
      const result = await checkMigrations(ctx.db);
      if (result.ready) {
        res.json({ status: "ready", migrations: result });
      } else {
        res.status(503).json({ status: "not-ready", migrations: result });
      }
    } catch (err: any) {
      res.status(503).json({
        status: "not-ready",
        error: err.message ?? String(err),
      });
    }
  },
});

// About endpoint
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/about",
  tags: ["System"],
  summary: "API metadata",
  response: z.object({
    name: z.string(),
    version: z.string(),
    buildTime: z.string(),
    environment: z.string(),
    description: z.string(),
    workers: z.array(z.string()),
  }),
  handler: async (_req, res) => {
    const agents = await ctx.agentCollection
      .find({
        deletedAt: { $exists: false },
        available: true,
        versions: {
          $elemMatch: {
            status: "active",
            queueName: { $type: "string", $ne: "" },
          },
        },
      })
      .project({ _id: 1 })
      .sort({ _id: 1 })
      .toArray();
    res.json({
      name: "Multi-Worker API (MongoDB)",
      version: (process.env.GIT_COMMIT || "development"),
      buildTime: (process.env.BUILD_TIME || new Date().toISOString()),
      environment: (process.env.SCOPE_ENVIRONMENT || "production"),
      description: "API that routes requests to multiple workers via separate queues",
      workers: agents.map((agent) => agent._id),
    });
  },
});

// Version endpoint
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/version",
  tags: ["System"],
  summary: "Version info",
  response: z.object({
    commit: z.string(),
    buildTime: z.string(),
    environment: z.string(),
    strictAgentCapabilities: z.boolean(),
  }),
  handler: async (_req, res) => {
    res.json({
      commit: (process.env.GIT_COMMIT || "development"),
      buildTime: (process.env.BUILD_TIME || new Date().toISOString()),
      environment: (process.env.SCOPE_ENVIRONMENT || "production"),
      strictAgentCapabilities: ctx.strictAgentCapabilities,
    });
  },
});

}
