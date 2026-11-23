// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RestError } from "@azure/storage-blob";
import { z } from "zod";
import type { RunState } from "shared";
import type { Request, Response } from "express";
import { pipeline } from "node:stream/promises";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";
import { resolveRunForRequest } from "./resolve-run.js";
import { createBlobServiceClient, extractBlobName } from "./blob-helpers.js";

export function parseVideoRange(header: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || (!match[1] && !match[2])) return;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return;
  if (first === undefined) {
    if (!last) return;
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && last < first)) return;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

async function handleVideo(
  ctx: RouteContext,
  req: Request,
  res: Response,
  targetRun: RunState | undefined,
  id: string,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const iterationParam = req.query.iteration;
  const phaseParam = req.query.phase;
  const indexParam = req.query.index;
  const videoIndex = indexParam === undefined ? 0
    : typeof indexParam === "string" && /^\d+$/.test(indexParam) ? Number(indexParam) : NaN;
  if (!Number.isSafeInteger(videoIndex) || videoIndex < 0) {
    res.status(400).json({ error: "Invalid video index" });
    return;
  }
  if (phaseParam !== undefined && phaseParam !== "setup") {
    res.status(400).json({ error: "Invalid video phase" });
    return;
  }
  if (iterationParam !== undefined && (typeof iterationParam !== "string" ||
      !/^[1-9]\d*$/.test(iterationParam) || !Number.isSafeInteger(Number(iterationParam)))) {
    res.status(400).json({ error: "Invalid iteration number" });
    return;
  }

  // Determine the videoUrls array — from setup, a specific turn, or from the top-level document
  let videoUrls: string[] | undefined;
  let label: string;

  if (phaseParam === "setup") {
    videoUrls = targetRun?.setupVideoUrls;
    label = `${id}-setup-video-${videoIndex}`;
  } else if (iterationParam) {
    const iterNum = Number(iterationParam);
    const turns = targetRun?.turns;
    const turn = turns?.find((t: { iteration: number }) => t.iteration === iterNum);
    videoUrls = turn?.videoUrls;
    label = `${id}-iteration-${iterNum}-video-${videoIndex}`;
  } else {
    // One-shot: videoUrls on run; multi-turn fallback: last turn
    const turns = targetRun?.turns;
    videoUrls = targetRun?.videoUrls ?? turns?.[turns.length - 1]?.videoUrls;
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

  const controller = new AbortController();
  const disconnected = () => { if (!res.writableFinished) controller.abort(); };
  res.once("close", disconnected);
  if (req.aborted || res.destroyed) controller.abort();
  try {
    const properties = await blobClient.getProperties({ abortSignal: controller.signal });
    const totalSize = properties.contentLength ?? 0;
    const rangeHeader = req.headers.range;
    const range = rangeHeader === undefined ? undefined : parseVideoRange(rangeHeader, totalSize);
    res.setHeader("Accept-Ranges", "bytes");
    if (rangeHeader !== undefined && !range) {
      res.setHeader("Content-Range", `bytes */${totalSize}`);
      res.status(416).json({ error: "Requested video range is not satisfiable" });
      return;
    }
    const count = range ? range.end - range.start + 1 : undefined;
    const downloadResponse = await blobClient.download(range?.start ?? 0, count, { abortSignal: controller.signal });
    if (!downloadResponse.readableStreamBody) {
      res.status(500).json({ error: "Failed to download video file" });
      return;
    }
    res.status(range ? 206 : 200);
    res.setHeader("Content-Type", "video/webm");
    res.setHeader("Content-Disposition", `inline; filename="${label}.webm"`);
    res.setHeader("Content-Length", count ?? totalSize);
    if (range) res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
    await pipeline(downloadResponse.readableStreamBody, res, { signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    res.removeListener("close", disconnected);
  }
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

      await handleVideo(ctx, req, res, resource.run, id);
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
