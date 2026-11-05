// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { RunState } from "shared";
import type { RouteContext } from "../route-context.js";
import { createBlobServiceClient, extractBlobName } from "../routes/requests/blob-helpers.js";
import type { ShareBlobArtifact } from "./projection.js";
import type { RunShareDocument } from "./store.js";

export const MAX_SHARED_ARTIFACT_BYTES = 128 * 1024 * 1024;

export function scopedShareBlobName(
  url: string, container: string, share: RunShareDocument, run: RunState,
): string | null {
  let name: string;
  try {
    const raw = extractBlobName(url, `/${container}/`);
    if (!raw) return null;
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (name.includes("\\") || name.split("/").some((part) => part === "." || part === "..")) return null;
  const attemptPrefix = `${share.requestId}/runs/${share.runId}/`;
  if (name.startsWith(attemptPrefix)) return name;
  // Pre-attempt storage layouts can only be attributed to the first attempt.
  const legacyPrefix = `${share.requestId}/`;
  if (run.attemptNumber === 1 && name.startsWith(legacyPrefix) &&
      !name.slice(legacyPrefix.length).startsWith("runs/")) return name;
  return null;
}

export function parseSharedRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) ||
      (last !== undefined && !Number.isSafeInteger(last))) return null;
  const start = first ?? Math.max(0, size - (last ?? 0));
  const end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (start >= size || start > end || (first === undefined && last === 0)) return null;
  return { start, end };
}

export async function sendSharedArtifact(
  ctx: RouteContext, req: Request, res: Response,
  share: RunShareDocument, run: RunState, artifact: ShareBlobArtifact,
): Promise<void> {
  const name = scopedShareBlobName(artifact.url, artifact.container, share, run);
  if (!name) {
    console.warn("Shared artifact has no verified attempt storage path", { shareId: share._id, artifactId: artifact.id });
    res.status(404).json({ error: "Artifact is unavailable" });
    return;
  }
  // Azure's SDK owns the single retry layer for blob requests.
  const blob = createBlobServiceClient(ctx).getContainerClient(artifact.container).getBlockBlobClient(name);
  const properties = await blob.getProperties();
  const size = properties.contentLength;
  if (size === undefined) throw new Error("Shared artifact has no content length");
  if (size > MAX_SHARED_ARTIFACT_BYTES) {
    res.status(413).json({ error: "This artifact exceeds the 128 MiB public download limit" });
    return;
  }
  const range = req.headers.range ? parseSharedRange(req.headers.range, size) : undefined;
  if (range === null) {
    res.setHeader("Content-Range", `bytes */${size}`);
    res.status(416).json({ error: "Requested byte range is not satisfiable" });
    return;
  }
  const response = req.method === "HEAD" ? undefined : range
    ? await blob.download(range.start, range.end - range.start + 1)
    : await blob.download();
  if (response && !response.readableStreamBody) throw new Error("Shared artifact download returned no stream");
  res.set({
    "Content-Type": artifact.contentType,
    "Content-Disposition": `attachment; filename="${artifact.filename}"`,
    "Accept-Ranges": "bytes",
  });
  if (range) {
    res.status(206).set({
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": String(range.end - range.start + 1),
    });
  } else res.setHeader("Content-Length", size);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  if (!response?.readableStreamBody) throw new Error("Shared artifact download returned no stream");
  await pipeline(response.readableStreamBody, res);
}
