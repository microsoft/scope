// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RestError } from "@azure/storage-blob";
import { createGzip } from "zlib";
import { pack as tarPack } from "tar-stream";
import { z } from "zod";
import type { RunState } from "@scope/core";
import type { Response } from "express";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext, RequestDocument } from "../../route-context.js";
import { packRunIntoTar } from "../../archive-har.js";
import type { ArchivableRun } from "../../archive-har.js";
import { resolveRunForRequest } from "./resolve-run.js";
import { createBlobServiceClient } from "./blob-helpers.js";

const isBlobNotFound = (err: unknown) =>
  err instanceof RestError &&
  (err.statusCode === 404 || err.code === "ContainerNotFound" || err.code === "BlobNotFound");

async function handleArchive(
  ctx: RouteContext,
  res: Response,
  resource: RequestDocument,
  targetRun: RunState,
  id: string,
): Promise<void> {
  const allTurns = targetRun.turns;
  if (!allTurns || allTurns.length === 0) {
    res.status(404).json({ error: "No iterations found for this run" });
    return;
  }

  const blobServiceClient = createBlobServiceClient(ctx);
  const containerClient = blobServiceClient.getContainerClient("snapshots");
  const logsContainerClient = blobServiceClient.getContainerClient("logs");

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${id}.tar.gz"`);

  const pack = tarPack();
  const gzip = createGzip();
  pack.pipe(gzip).pipe(res);

  const archiveResource = { ...resource, run: targetRun } as unknown as ArchivableRun;
  await packRunIntoTar(pack, archiveResource, containerClient, id, isBlobNotFound, logsContainerClient);

  pack.finalize();
}

export function registerRequestsArchiveRoutes(ctx: RouteContext): void {

// Request-level archive download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/archive",
  tags: ["Requests"],
  summary: "Download full run archive",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped run archive",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
      const { id } = req.params;

      const resource = await ctx.requestCollection.findOne({ _id: id });
      if (!resource) {
        res.status(404).json({ error: "Request not found" });
        return;
      }

      await handleArchive(ctx, res, resource, resource.run!, id);
    } catch (error) {
      if (!res.headersSent) {
        if (isBlobNotFound(error)) {
          res.status(404).json({ error: "Snapshot not found — the blob may have been deleted or is no longer available" });
          return;
        }
        throw error;
      } else {
        res.destroy();
      }
    }
  },
});

// Per-run archive download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/runs/:runId/archive",
  tags: ["Requests"],
  summary: "Download full run archive for a specific attempt",
  params: z.object({ id: z.string(), runId: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped run archive",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
      const { id, runId } = req.params;

      const resolved = await resolveRunForRequest(ctx, id, runId);
      if ("error" in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      await handleArchive(ctx, res, resolved.request, resolved.run, id);
    } catch (error) {
      if (!res.headersSent) {
        if (isBlobNotFound(error)) {
          res.status(404).json({ error: "Archive not found — the blob may have been deleted or is no longer available" });
          return;
        }
        throw error;
      }
      console.error(`Error streaming archive for request ${req.params.id}:`, error);
      res.end();
    }
  },
});

}
