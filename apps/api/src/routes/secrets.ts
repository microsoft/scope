// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Request, Response, NextFunction } from "express";
import type { RouteContext } from "../route-context.js";

// =============================================================================
// Token Manager proxy (admin CRUD - excludes /acquire which is worker-only)
// =============================================================================

export function registerSecretsRoutes(ctx: RouteContext): void {
  const TOKEN_MANAGER_URL = process.env.TOKEN_MANAGER_URL || "";

  if (!TOKEN_MANAGER_URL) {
    console.log("[api] Token Manager proxy disabled (TOKEN_MANAGER_URL not set)");
    return;
  }

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
      const upstream = await fetch(targetUrl, fetchOpts);
      const contentType = upstream.headers.get("content-type") || "application/json";
      const body = await upstream.text();
      res.status(upstream.status).set("content-type", contentType).send(body);
    } catch (error) {
      next(error);
    }
  };

  // CRUD routes proxied to Token Manager (portal uses these)
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
