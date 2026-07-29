// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RestError } from "@azure/storage-blob";
import { z, type ZodType } from "zod";
import type { RunState } from "@scope/core";
import type { Request, Response } from "express";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";
import { resolveRunForRequest } from "./resolve-run.js";

/**
 * Handler signature for artifact download endpoints.
 * Receives the resolved run and request metadata; responsible for
 * locating the blob URL and calling downloadBlobToResponse.
 */
export type ArtifactHandler = (
  ctx: RouteContext,
  req: Request,
  res: Response,
  targetRun: RunState,
  id: string,
) => Promise<void>;

export interface ArtifactRouteOptions {
  /** URL path segment after `/requests/:id/` (e.g. "atif", "har", "tool-calls") */
  path: string;
  summary: string;
  /** Summary for the per-run variant (defaults to `${summary} for a specific attempt`) */
  perRunSummary?: string;
  responseDescription: string;
  /** Additional error responses for OpenAPI docs */
  errorResponses?: Record<number, { description: string }>;
  /** Query schema for OpenAPI docs (e.g. iteration parameter) */
  query?: ZodType;
  /** Additional path params beyond :id (used for snapshot's :iteration) */
  extraParams?: ZodType;
  /** Error message when blob is not found in storage */
  blobNotFoundMessage: string;
  /** The handler that resolves the artifact URL and streams it */
  handler: ArtifactHandler;
}

/**
 * Register both the request-level and per-run variants of an artifact
 * download endpoint. Handles request lookup, run resolution, RestError
 * catching, and OpenAPI registration for both routes.
 */
export function registerArtifactRoutes(ctx: RouteContext, options: ArtifactRouteOptions): void {
  const {
    path: artifactPath,
    summary,
    perRunSummary = `${summary} for a specific attempt`,
    responseDescription,
    errorResponses = { 404: { description: "Not found" } },
    query,
    extraParams,
    blobNotFoundMessage,
    handler,
  } = options;

  const requestParams = extraParams
    ? z.object({ id: z.string() }).merge(extraParams as any)
    : z.object({ id: z.string() });

  const runParams = extraParams
    ? z.object({ id: z.string(), runId: z.string() }).merge(extraParams as any)
    : z.object({ id: z.string(), runId: z.string() });

  // Request-level route
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: `/api/v1/requests/:id/${artifactPath}`,
    tags: ["Requests"],
    summary,
    params: requestParams,
    ...(query ? { query } : {}),
    response: z.any(),
    rawResponse: true,
    responseDescription,
    errorResponses,
    handler: async (req, res) => {
      try {
        const { id } = req.params;

        const resource = await ctx.requestCollection.findOne({ _id: id });
        if (!resource) {
          res.status(404).json({ error: "Request not found" });
          return;
        }

        if (!resource.run) {
          res.status(404).json({ error: "Request has no run data" });
          return;
        }

        await handler(ctx, req, res, resource.run, id);
      } catch (error) {
        if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
          res.status(404).json({ error: blobNotFoundMessage });
          return;
        }
        throw error;
      }
    },
  });

  // Per-run route
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: `/api/v1/requests/:id/runs/:runId/${artifactPath}`,
    tags: ["Requests"],
    summary: perRunSummary,
    params: runParams,
    ...(query ? { query } : {}),
    response: z.any(),
    rawResponse: true,
    responseDescription,
    errorResponses,
    handler: async (req, res) => {
      try {
        const { id, runId } = req.params;

        const resolved = await resolveRunForRequest(ctx, id, runId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }

        await handler(ctx, req, res, resolved.run, id);
      } catch (error) {
        if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
          res.status(404).json({ error: blobNotFoundMessage });
          return;
        }
        throw error;
      }
    },
  });
}
