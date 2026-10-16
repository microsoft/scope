// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  CreateRunShareSchema, RunShareLinkSchema, RunShareListSchema, RunShareSchema, UpdateRunShareSchema,
} from "shared/run-sharing";
import { getUser } from "../auth/types.js";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import { isRunSharingEnabled, shareRateLimit, shareResponseHeaders } from "../run-sharing/guards.js";
import { RunShareStore, type RunShareDocument, type SharePublisher } from "../run-sharing/store.js";
import { resolveRunForRequest } from "./requests/resolve-run.js";
import type { Request, Response } from "express";

const targetParams = z.object({ id: z.string(), runId: z.string() });
const shareParams = targetParams.extend({ shareId: z.string().uuid() });
const basePath = "/api/v1/requests/:id/runs/:runId/shares";
const publisherSecurity = [{ bearerAuth: [] }];
const managementErrors = {
  401: { description: "Active Scope user required" },
  404: { description: "Sharing disabled, attempt unavailable, or link not owned by this user" },
  429: { description: "Rate limited" },
};

export function registerRunShareRoutes(ctx: RouteContext): void {
  const store = () => new RunShareStore(ctx.db.collection<RunShareDocument>("run-shares"));
  ctx.app.use(basePath, shareResponseHeaders, shareRateLimit(60), (req, res, next) => {
    if (!isRunSharingEnabled()) {
      res.status(404).json({ error: "Run sharing is disabled" });
      return;
    }
    if (!getUser(req).isAuthenticated || getUser(req).isService) {
      res.status(401).json({ error: "Sign in to Scope to manage shared run links" });
      return;
    }
    next();
  });

  async function publisher(req: Request, res: Response): Promise<SharePublisher | null> {
    const resolved = await resolveRunForRequest(ctx, req.params.id, req.params.runId, { excludeDeleted: true });
    if ("error" in resolved) {
      res.status(404).json({ error: "Run attempt not found" });
      return null;
    }
    return {
      requestId: resolved.request._id, runId: resolved.run._id,
      projectId: resolved.request.projectId, createdBy: getUser(req).id,
    };
  }

  function validateExpiry(value: string | null | undefined, res: Response): boolean {
    if (value && new Date(value).getTime() <= Date.now()) {
      res.status(400).json({ error: "Expiry must be in the future" });
      return false;
    }
    return true;
  }

  apiRoute(ctx.app, ctx.registry, {
    method: "post", path: basePath, tags: ["Run sharing"], summary: "Create a public, read-only link to a run attempt",
    security: publisherSecurity,
    params: targetParams, body: CreateRunShareSchema, response: RunShareLinkSchema,
    errorResponses: { ...managementErrors, 400: { description: "Invalid content policy or expiry" } },
    handler: async (req, res) => {
      const owner = await publisher(req, res);
      if (!owner || !validateExpiry(req.body.expiresAt, res)) return;
      const expiresAt = req.body.expiresAt === null ? null
        : req.body.expiresAt ? new Date(req.body.expiresAt) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      res.status(201).json(await store().create(owner, {
        label: req.body.label, content: req.body.content, expiresAt,
      }));
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: basePath, tags: ["Run sharing"], summary: "List your links for this attempt (50 per page)",
    security: publisherSecurity, errorResponses: managementErrors,
    params: targetParams, query: z.object({ after: z.string().uuid().optional() }).strict(),
    response: RunShareListSchema,
    handler: async (req, res) => {
      const owner = await publisher(req, res);
      if (owner) res.json(await store().list(owner, req.query.after));
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "patch", path: `${basePath}/:shareId`, tags: ["Run sharing"], summary: "Update your shared link's policy or expiry",
    security: publisherSecurity, errorResponses: { ...managementErrors, 400: { description: "Invalid policy or expiry" } },
    params: shareParams, body: UpdateRunShareSchema, response: RunShareSchema,
    handler: async (req, res) => {
      const owner = await publisher(req, res);
      if (!owner || !validateExpiry(req.body.expiresAt, res)) return;
      const updated = await store().update(owner, req.params.shareId, req.body);
      if (!updated) res.status(404).json({ error: "Shared link not found or revoked" });
      else res.json(updated);
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "delete", path: `${basePath}/:shareId`, tags: ["Run sharing"], summary: "Revoke your shared run link",
    security: publisherSecurity, errorResponses: managementErrors,
    params: shareParams, response: RunShareSchema,
    handler: async (req, res) => {
      const owner = await publisher(req, res);
      if (!owner) return;
      const revoked = await store().revoke(owner, req.params.shareId);
      if (!revoked) res.status(404).json({ error: "Shared link not found" });
      else res.json(revoked);
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post", path: `${basePath}/:shareId/rotate`, tags: ["Run sharing"], summary: "Replace your link's secret and invalidate its previous URL",
    security: publisherSecurity, errorResponses: managementErrors,
    params: shareParams, response: RunShareLinkSchema, successStatus: 200,
    handler: async (req, res) => {
      const owner = await publisher(req, res);
      if (!owner) return;
      const rotated = await store().rotate(owner, req.params.shareId);
      if (!rotated) res.status(404).json({ error: "Shared link not found or revoked" });
      else res.json(rotated);
    },
  });
}
