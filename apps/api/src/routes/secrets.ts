// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Request, Response, NextFunction } from "express";
import type { RouteContext } from "../route-context.js";
import { Authorization } from "../auth/authorization.js";

// =============================================================================
// Token Manager proxy (admin CRUD - excludes /acquire which is worker-only)
// =============================================================================

export function registerSecretsRoutes(ctx: Pick<RouteContext, "app" | "db" | "authEnabled">): void {
  const TOKEN_MANAGER_URL = process.env.TOKEN_MANAGER_URL || "";

  if (!TOKEN_MANAGER_URL) {
    console.log("[api] Token Manager proxy disabled (TOKEN_MANAGER_URL not set)");
  }

  const proxyToTokenManager = async (req: Request, res: Response, next: NextFunction) => {
    try {
      await new Authorization(ctx.db, ctx.authEnabled).guard(req, req.method.toLowerCase(), req.path, "platform");
      res.set("Cache-Control", "no-store");
      if (!TOKEN_MANAGER_URL) {
        res.status(503).json({
          error: "Secrets service is unavailable. Configure TOKEN_MANAGER_URL and start Token Manager.",
          code: "token_manager_unavailable",
        });
        return;
      }
      const targetUrl = `${TOKEN_MANAGER_URL}${req.originalUrl}`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const fetchOpts: RequestInit = {
        method: req.method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        fetchOpts.body = JSON.stringify(req.body);
      }
      try {
        // Callers own retries; never replay a credential mutation in this proxy.
        const upstream = await fetch(targetUrl, fetchOpts);
        const contentType = upstream.headers.get("content-type") || "application/json";
        const body = await upstream.text();
        if (upstream.status >= 500) throw new Error("Token Manager returned a server error");
        res.status(upstream.status).set("content-type", contentType).send(body);
      } catch {
        console.error("[api] Token Manager request failed", req.method, req.path);
        res.status(503).json({
          error: "Secrets service is unavailable. Check that Token Manager and its secret store are running, then try again.",
          code: "token_manager_unavailable",
        });
      }
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

  if (TOKEN_MANAGER_URL) console.log(`[api] Token Manager proxy enabled → ${TOKEN_MANAGER_URL}`);
}
