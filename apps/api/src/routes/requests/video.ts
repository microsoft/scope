// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RestError } from "@azure/storage-blob";
import { z } from "zod";
import type { RunState } from "@scope/core";
import type { Request, Response } from "express";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";
import { resolveRunForRequest } from "./resolve-run.js";
import { createBlobServiceClient, extractBlobName } from "./blob-helpers.js";

async function handleVideo(
  ctx: RouteContext,
  req: Request,
  res: Response,
  targetRun: RunState,
  id: string,
): Promise<void> {
  const iterationParam = req.query.iteration as string | undefined;
  const phaseParam = req.query.phase as string | undefined;
  const indexParam = req.query.index as string | undefined;
  const videoIndex = indexParam ? parseInt(indexParam, 10) : 0;

  if (isNaN(videoIndex) || videoIndex < 0) {
    res.status(400).json({ error: "Invalid video index" });
    return;
  }

  // Determine the videoUrls array — from setup, a specific turn, or from the top-level document
  let videoUrls: string[] | undefined;
  let label: string;

  if (phaseParam === "setup") {
    videoUrls = targetRun.setupVideoUrls;
    label = `${id}-setup-video-${videoIndex}`;
  } else if (iterationParam) {
    const iterNum = parseInt(iterationParam, 10);
    if (isNaN(iterNum) || iterNum < 1) {
      res.status(400).json({ error: "Invalid iteration number" });
      return;
    }
    const turns = targetRun.turns;
    const turn = turns?.find((t: { iteration: number }) => t.iteration === iterNum);
    videoUrls = turn?.videoUrls;
    label = `${id}-iteration-${iterNum}-video-${videoIndex}`;
  } else {
    // One-shot: videoUrls on run; multi-turn fallback: last turn
    const turns = targetRun.turns;
    videoUrls = targetRun.videoUrls ?? turns?.[turns.length - 1]?.videoUrls;
    label = `${id}-video-${videoIndex}`;
  }

  if (!videoUrls || videoUrls.length === 0) {
    res.status(404).json({ error: "No video recordings available" });
    return;
  }

  if (videoIndex >= videoUrls.length) {
    res.status(404).json({ error: `Video index ${videoIndex} not found (${videoUrls.length} available)` });
    return;
  }

  const videoUrl = videoUrls[videoIndex];

  const blobServiceClient = createBlobServiceClient(ctx);

  const blobName = extractBlobName(videoUrl);
  if (!blobName) {
    res.status(500).json({ error: "Invalid video URL format" });
    return;
  }
  const containerClient = blobServiceClient.getContainerClient("snapshots");
  const blobClient = containerClient.getBlockBlobClient(blobName);

  // Get blob properties for content length
  const properties = await blobClient.getProperties();
  const totalSize = properties.contentLength ?? 0;

  // Support HTTP Range requests for video seeking
  const rangeHeader = req.headers.range;
  if (rangeHeader && totalSize > 0) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      const chunkSize = end - start + 1;

      const downloadResponse = await blobClient.download(start, chunkSize);
      if (!downloadResponse.readableStreamBody) {
        res.status(500).json({ error: "Failed to download video file" });
        return;
      }

      res.status(206);
      res.setHeader("Content-Type", "video/webm");
      res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", chunkSize);
      downloadResponse.readableStreamBody.pipe(res);
      return;
    }
  }

  const downloadResponse = await blobClient.download();
  if (!downloadResponse.readableStreamBody) {
    res.status(500).json({ error: "Failed to download video file" });
    return;
  }

  res.setHeader("Content-Type", "video/webm");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", `inline; filename="${label}.webm"`);
  if (totalSize > 0) {
    res.setHeader("Content-Length", totalSize);
  }

  downloadResponse.readableStreamBody.pipe(res);
}

export function registerRequestsVideoRoutes(ctx: RouteContext): void {

// Request-level video download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/video",
  tags: ["Requests"],
  summary: "Download session recording",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "WebM video recording (supports Range requests)",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
      const { id } = req.params;

      const resource = await ctx.requestCollection.findOne({ _id: id });
      if (!resource) {
        res.status(404).json({ error: "Request not found" });
        return;
      }

      await handleVideo(ctx, req, res, resource.run!, id);
    } catch (error) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "Video file not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    }
  },
});

// Per-run video download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/runs/:runId/video",
  tags: ["Requests"],
  summary: "Download session recording for a specific attempt",
  params: z.object({ id: z.string(), runId: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "WebM video recording (supports Range requests)",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
      const { id, runId } = req.params;

      const resolved = await resolveRunForRequest(ctx, id, runId);
      if ("error" in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      await handleVideo(ctx, req, res, resolved.run, id);
    } catch (error) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "Video file not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    }
  },
});

}
