// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Request, Response, NextFunction } from "express";
import { withRetry, PortalAiSettingsSchema, UpdatePortalAiSettingsSchema } from "shared";
import type { RouteContext } from "../route-context.js";
import { apiRoute } from "../openapi/api-route.js";

// =============================================================================
// Token Manager proxy (admin CRUD - excludes /acquire which is worker-only)
// =============================================================================

export function registerSecretsRoutes(ctx: Pick<RouteContext, "app" | "registry">): void {
  const TOKEN_MANAGER_URL = process.env.TOKEN_MANAGER_URL || "";

  const proxyToTokenManager = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetUrl = `${TOKEN_MANAGER_URL}${req.originalUrl}`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const fetchOpts: RequestInit = {
        method: req.method,
        headers,
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        fetchOpts.body = JSON.stringify(req.body);
      }
      let upstream: globalThis.Response;
      if (req.path === "/api/v1/keys/portal-ai") {
        upstream = await withRetry(async () => {
          const response = await fetch(targetUrl, { ...fetchOpts, signal: AbortSignal.timeout(10_000) });
          if (response.status === 429 || response.status >= 500) {
            throw new Error(`Token Manager settings temporarily unavailable (HTTP ${response.status})`);
          }
          return response;
        }, { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 5000, isRetryable: () => true });
      } else {
        upstream = await fetch(targetUrl, fetchOpts);
      }
      const contentType = upstream.headers.get("content-type") || "application/json";
      const body = await upstream.text();
      res.status(upstream.status).set("content-type", contentType).send(body);
    } catch (error) {
      next(error);
    }
  };

  const proxyPortalAiSettings = async (req: Request, res: Response, next: NextFunction) => {
    if (!TOKEN_MANAGER_URL) {
      res.status(503).json({ error: "Token Manager is not configured" });
      return;
    }
    await proxyToTokenManager(req, res, next);
  };

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/keys/portal-ai",
    tags: ["Secrets"],
    summary: "Get the Portal AI provider selection",
    response: PortalAiSettingsSchema,
    errorResponses: { 503: { description: "Token Manager is not configured" } },
    handler: proxyPortalAiSettings,
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "put",
    path: "/api/v1/keys/portal-ai",
    tags: ["Secrets"],
    summary: "Replace the Portal AI provider selection",
    body: UpdatePortalAiSettingsSchema,
    response: PortalAiSettingsSchema,
    errorResponses: {
      400: { description: "Invalid selection or pinned credential is unavailable for this provider" },
      503: { description: "Token Manager is not configured" },
    },
    handler: proxyPortalAiSettings,
  });

  if (!TOKEN_MANAGER_URL) {
    console.log("[api] Token Manager proxy disabled (TOKEN_MANAGER_URL not set)");
    return;
  }

  // Existing CRUD routes remain ordinary proxies.
  ctx.app.post("/api/v1/keys/preview", proxyToTokenManager);   // must be before :id routes
  ctx.app.post("/api/v1/keys", proxyToTokenManager);
  ctx.app.get("/api/v1/keys", proxyToTokenManager);
  ctx.app.get("/api/v1/keys/:id", proxyToTokenManager);
  ctx.app.put("/api/v1/keys/:id", proxyToTokenManager);
  ctx.app.delete("/api/v1/keys/:id", proxyToTokenManager);
  ctx.app.post("/api/v1/keys/:id/validate", proxyToTokenManager);
  // NOTE: POST /api/v1/keys/acquire is intentionally NOT proxied.
  // Workers call token-manager directly (ClusterIP) for /acquire.

  // Account CRUD routes proxied to Token Manager (portal uses these)
  ctx.app.post("/api/v1/accounts", proxyToTokenManager);
  ctx.app.get("/api/v1/accounts", proxyToTokenManager);
  ctx.app.get("/api/v1/accounts/:id", proxyToTokenManager);
  ctx.app.put("/api/v1/accounts/:id", proxyToTokenManager);
  ctx.app.delete("/api/v1/accounts/:id", proxyToTokenManager);
  // NOTE: GET /api/v1/accounts/:id/secrets is intentionally NOT proxied.
  // Key-updaters call token-manager directly (ClusterIP) for secrets.

  console.log(`[api] Token Manager proxy enabled → ${TOKEN_MANAGER_URL}`);
}
