// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for bundling HAR and raw chat export files in run archives.
 *
 * Extracted from the archive download/upload endpoints so the logic
 * is independently testable without Express, MongoDB, or blob-storage mocks.
 */

import type { Pack } from "tar-stream";
import { stringify as yamlStringify } from "yaml";
import { pipeline } from "stream/promises";
import type { RestError } from "@azure/storage-blob";

/**
 * Extract the blob name from an Azure Blob Storage URL whose container is "snapshots".
 * Works with both production URLs and Azurite (local emulator) URLs.
 *
 * @returns The blob name (path after `/snapshots/`), or `null` if the URL doesn't match.
 */
export function blobNameFromSnapshotsUrl(url: string): string | null {
  const parsed = new URL(url);
  const prefix = "/snapshots/";
  const idx = parsed.pathname.indexOf(prefix);
  return idx === -1 ? null : parsed.pathname.substring(idx + prefix.length);
}

/**
 * Extract the blob name from an Azure Blob Storage URL whose container is "logs".
 * Works with both production URLs and Azurite (local emulator) URLs.
 *
 * @returns The blob name (path after `/logs/`), or `null` if the URL doesn't match.
 */
export function blobNameFromLogsUrl(url: string): string | null {
  const parsed = new URL(url);
  const prefix = "/logs/";
  const idx = parsed.pathname.indexOf(prefix);
  return idx === -1 ? null : parsed.pathname.substring(idx + prefix.length);
}

/**
 * Deep-clone a run resource and rewrite `harUrl`, `rawChatUrl`,
 * `chatResultUrl`, and `toolCallsUrl` fields to relative archive paths.
 *
 * - `run.harUrl`              → `"run.har"`
 * - Per-turn `harUrl`          → `"iteration-{N}.har"`
 * - `run.rawChatUrl`           → `"run.chat-export.json"`
 * - Per-turn `rawChatUrl`      → `"iteration-{N}.chat-export.json"`
 * - Per-turn `chatResultUrl`   → `"iteration-{N}.chat-result.json"`
 * - Per-turn `toolCallsUrl`    → `"iteration-{N}.tool-calls.jsonl"`
 */
export function rewriteHarUrlsForArchive<T extends {
  run?: {
    harUrl?: string;
    rawChatUrl?: string;
    turns?: Array<{ iteration: number; harUrl?: string; rawChatUrl?: string; chatResultUrl?: string; toolCallsUrl?: string; atifUrl?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
}>(resource: T): T {
  const copy = JSON.parse(JSON.stringify(resource));
  if (copy.run) {
    // Archives are user-facing; drop the server-only run-token digest.
    delete copy.run.tokenHash;
    if (copy.run.harUrl) {
      copy.run.harUrl = "run.har";
    }
    if (copy.run.rawChatUrl) {
      copy.run.rawChatUrl = "run.chat-export.json";
    }
    if (copy.run.turns) {
      for (const turn of copy.run.turns) {
        if (turn.harUrl) {
          turn.harUrl = `iteration-${turn.iteration}.har`;
        }
        if (turn.rawChatUrl) {
          turn.rawChatUrl = `iteration-${turn.iteration}.chat-export.json`;
        }
        if (turn.chatResultUrl) {
          turn.chatResultUrl = `iteration-${turn.iteration}.chat-result.json`;
        }
        if (turn.toolCallsUrl) {
          turn.toolCallsUrl = `iteration-${turn.iteration}.tool-calls.jsonl`;
        }
        if (turn.atifUrl) {
          turn.atifUrl = `iteration-${turn.iteration}.atif.trajectory.json`;
        }
      }
    }
  }
  return copy;
}

/** Describes a HAR file found in an extracted archive directory. */
export interface DetectedHarFile {
  fileName: string;
  /** Iteration number (for per-turn files), or `null` for top-level `run.har`. */
  iteration: number | null;
}

/**
 * Scan a list of filenames and return the HAR files that follow the bundled naming convention:
 * - `iteration-{N}.har` → per-turn HAR
 * - `run.har`           → top-level HAR
 *
 * Other `.har` files are ignored.
 */
export function detectBundledHarFiles(fileNames: string[]): DetectedHarFile[] {
  const results: DetectedHarFile[] = [];
  for (const name of fileNames) {
    if (!name.endsWith(".har")) continue;
    const iterMatch = name.match(/^iteration-(\d+)\.har$/);
    if (iterMatch) {
      results.push({ fileName: name, iteration: parseInt(iterMatch[1], 10) });
    } else if (name === "run.har") {
      results.push({ fileName: name, iteration: null });
    }
  }
  return results;
}

/** Minimal interface matching the blob-upload methods we need from @azure/storage-blob. */
export interface BlobUploader {
  getBlockBlobClient(blobName: string): {
    url: string;
    uploadFile(filePath: string, options?: { blobHTTPHeaders?: { blobContentType?: string }; tags?: Record<string, string> }): Promise<unknown>;
  };
}

/**
 * Upload detected HAR files from an extracted archive directory to blob storage.
 * Mutates `turns` and returns the top-level `harUrl` (if any).
 */
export async function uploadBundledHarFiles(opts: {
  harFiles: DetectedHarFile[];
  runDir: string;
  runId: string;
  turns: Array<{ iteration: number; harUrl?: string; [key: string]: unknown }>;
  containerClient: BlobUploader;
}): Promise<string | undefined> {
  const { harFiles, runDir, runId, turns, containerClient } = opts;
  const { join } = await import("node:path");
  let topLevelHarUrl: string | undefined;

  for (const har of harFiles) {
    const harPath = join(runDir, har.fileName);

    if (har.iteration !== null) {
      // Per-turn HAR: iteration-N.har
      const blobName = `${runId}/iteration-${har.iteration}/capture.har`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(harPath, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        tags: { requestId: runId, iteration: String(har.iteration) },
      });
      const turn = turns.find(t => t.iteration === har.iteration);
      if (turn) {
        turn.harUrl = blockBlobClient.url;
      }
    } else {
      // Top-level HAR (one-shot runs): run.har
      const blobName = `${runId}/capture.har`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(harPath, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        tags: { requestId: runId },
      });
      topLevelHarUrl = blockBlobClient.url;
    }
  }

  return topLevelHarUrl;
}

/** Describes a raw chat export file found in an extracted archive directory. */
export interface DetectedChatFile {
  fileName: string;
  /** Iteration number (for per-turn files), or `null` for top-level `run.chat-export.json`. */
  iteration: number | null;
}

/**
 * Scan a list of filenames and return the chat export files that follow the bundled naming convention:
 * - `iteration-{N}.chat-export.json` → per-turn chat export
 * - `run.chat-export.json`           → top-level chat export
 */
export function detectBundledChatFiles(fileNames: string[]): DetectedChatFile[] {
  const results: DetectedChatFile[] = [];
  for (const name of fileNames) {
    if (!name.endsWith(".chat-export.json")) continue;
    const iterMatch = name.match(/^iteration-(\d+)\.chat-export\.json$/);
    if (iterMatch) {
      results.push({ fileName: name, iteration: parseInt(iterMatch[1], 10) });
    } else if (name === "run.chat-export.json") {
      results.push({ fileName: name, iteration: null });
    }
  }
  return results;
}

/**
 * Upload detected chat export files from an extracted archive directory to blob storage.
 * Mutates `turns` and returns the top-level `rawChatUrl` (if any).
 */
export async function uploadBundledChatFiles(opts: {
  chatFiles: DetectedChatFile[];
  runDir: string;
  runId: string;
  turns: Array<{ iteration: number; rawChatUrl?: string; [key: string]: unknown }>;
  containerClient: BlobUploader;
}): Promise<string | undefined> {
  const { chatFiles, runDir, runId, turns, containerClient } = opts;
  const { join } = await import("node:path");
  let topLevelChatUrl: string | undefined;

  for (const chat of chatFiles) {
    const chatPath = join(runDir, chat.fileName);

    if (chat.iteration !== null) {
      const blobName = `${runId}/iteration-${chat.iteration}/chat-export.json`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(chatPath, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        tags: { requestId: runId, iteration: String(chat.iteration) },
      });
      const turn = turns.find(t => t.iteration === chat.iteration);
      if (turn) {
        turn.rawChatUrl = blockBlobClient.url;
      }
    } else {
      const blobName = `${runId}/chat-export.json`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(chatPath, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        tags: { requestId: runId },
      });
      topLevelChatUrl = blockBlobClient.url;
    }
  }

  return topLevelChatUrl;
}

/** Describes a per-iteration tool-calls JSONL file found in an extracted archive directory. */
export interface DetectedToolCallsFile {
  fileName: string;
  /** Iteration number — tool-calls JSONL is always per-iteration. */
  iteration: number;
}

/**
 * Scan a list of filenames and return tool-calls JSONL files that follow the
 * bundled naming convention: `iteration-{N}.tool-calls.jsonl`.
 */
export function detectBundledToolCallsFiles(fileNames: string[]): DetectedToolCallsFile[] {
  const results: DetectedToolCallsFile[] = [];
  for (const name of fileNames) {
    const m = name.match(/^iteration-(\d+)\.tool-calls\.jsonl$/);
    if (m) {
      results.push({ fileName: name, iteration: parseInt(m[1], 10) });
    }
  }
  return results;
}

/**
 * Upload detected tool-calls JSONL files from an extracted archive directory
 * to blob storage. Mutates each matching turn's `toolCallsUrl` to the new blob URL.
 *
 * Note: the archived files are uploaded as block blobs (snapshot of the JSONL)
 * rather than append blobs — re-imported runs are already complete, so the
 * append semantics aren't needed.
 */
export async function uploadBundledToolCallsFiles(opts: {
  toolCallsFiles: DetectedToolCallsFile[];
  runDir: string;
  runId: string;
  turns: Array<{ iteration: number; toolCallsUrl?: string; [key: string]: unknown }>;
  containerClient: BlobUploader;
}): Promise<void> {
  const { toolCallsFiles, runDir, runId, turns, containerClient } = opts;
  const { join } = await import("node:path");

  for (const tc of toolCallsFiles) {
    const filePath = join(runDir, tc.fileName);
    const blobName = `${runId}/iteration-${tc.iteration}/tool-calls.jsonl`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadFile(filePath, {
      blobHTTPHeaders: { blobContentType: "application/x-ndjson" },
      tags: { requestId: runId, iteration: String(tc.iteration) },
    });
    const turn = turns.find(t => t.iteration === tc.iteration);
    if (turn) {
      turn.toolCallsUrl = blockBlobClient.url;
    }
  }
}

/** Describes a per-iteration chat-result JSON file found in an extracted archive directory. */
export interface DetectedChatResultFile {
  fileName: string;
  /** Iteration number — chat-result is always per-iteration. */
  iteration: number;
}

/**
 * Scan a list of filenames and return chat-result JSON files that follow the
 * bundled naming convention: `iteration-{N}.chat-result.json`.
 */
export function detectBundledChatResultFiles(fileNames: string[]): DetectedChatResultFile[] {
  const results: DetectedChatResultFile[] = [];
  for (const name of fileNames) {
    const m = name.match(/^iteration-(\d+)\.chat-result\.json$/);
    if (m) {
      results.push({ fileName: name, iteration: parseInt(m[1], 10) });
    }
  }
  return results;
}

/**
 * Upload detected chat-result JSON files from an extracted archive directory
 * to blob storage. Mutates each matching turn's `chatResultUrl` to the new blob URL.
 */
export async function uploadBundledChatResultFiles(opts: {
  chatResultFiles: DetectedChatResultFile[];
  runDir: string;
  runId: string;
  turns: Array<{ iteration: number; chatResultUrl?: string; [key: string]: unknown }>;
  containerClient: BlobUploader;
}): Promise<void> {
  const { chatResultFiles, runDir, runId, turns, containerClient } = opts;
  const { join } = await import("node:path");

  for (const cr of chatResultFiles) {
    const filePath = join(runDir, cr.fileName);
    const blobName = `${runId}/iteration-${cr.iteration}/chat-result.json`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadFile(filePath, {
      blobHTTPHeaders: { blobContentType: "application/json" },
      tags: { requestId: runId, iteration: String(cr.iteration) },
    });
    const turn = turns.find(t => t.iteration === cr.iteration);
    if (turn) {
      turn.chatResultUrl = blockBlobClient.url;
    }
  }
}

/** Minimal interface for blob download needed by packRunIntoTar. */
export interface BlobDownloader {
  getBlockBlobClient(blobName: string): {
    download(): Promise<{
      readableStreamBody?: NodeJS.ReadableStream;
      contentLength?: number;
    }>;
  };
  getBlobClient(blobName: string): {
    download(): Promise<{
      readableStreamBody?: NodeJS.ReadableStream;
      contentLength?: number;
    }>;
  };
}

/** A run document with the fields needed for archive packing. */
export interface ArchivableRun {
  _id: string;
  /** FK → CodebaseRevisionDocument._id when the run was seeded from a codebase. */
  codebaseRevisionId?: string;
  /**
   * Codebase revision provenance, attached by the archive route when the run
   * was seeded from a codebase. Serialized into run.yaml and its snapshot is
   * bundled as `codebase.tar.gz`. `archiveUrl` is rewritten to the relative
   * bundled path at pack time (the original blob URL is preserved in
   * `archiveBlobUrl`).
   */
  codebase?: {
    ref?: string;
    archiveUrl?: string;
    archiveBlobUrl?: string;
    [key: string]: unknown;
  };
  run?: {
    logsUrl?: string;
    harUrl?: string;
    rawChatUrl?: string;
    turns?: Array<{
      iteration: number;
      snapshotUrl?: string;
      harUrl?: string;
      rawChatUrl?: string;
      chatResultUrl?: string;
      toolCallsUrl?: string;
      atifUrl?: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Pack a single run's artifacts into a tar-stream pack instance.
 *
 * Writes entries under `{prefix}/` (typically the run ID). This function does
 * NOT finalize the pack — the caller is responsible for calling `pack.finalize()`
 * after all runs have been packed.
 *
 * @param pack       - tar-stream pack instance (shared across runs in batch mode)
 * @param resource   - the run document
 * @param container  - blob storage container client for downloading snapshots/HARs/chats
 * @param prefix     - directory prefix inside the tar (defaults to resource._id)
 * @param isRestError - predicate to check if an error is a blob-not-found RestError
 * @param logsContainer - optional blob storage container client for downloading logs (logs.jsonl)
 */
export async function packRunIntoTar(
  pack: Pack,
  resource: ArchivableRun,
  container: BlobDownloader,
  prefix?: string,
  isRestError?: (err: unknown) => boolean,
  logsContainer?: BlobDownloader,
): Promise<void> {
  const id = prefix ?? resource._id;
  const isBlobNotFound = isRestError ?? (() => false);

  // Entry 1: run.yaml — the full run document (with relative HAR paths)
  const archiveResource = rewriteHarUrlsForArchive(resource);
  // Rewrite the codebase archive URL to the bundled relative path so run.yaml
  // references the packed `codebase.tar.gz`, while preserving the original blob
  // URL under `archiveBlobUrl` for provenance.
  const codebaseBlobUrl = resource.codebase?.archiveUrl;
  if (archiveResource.codebase && codebaseBlobUrl) {
    archiveResource.codebase.archiveBlobUrl = codebaseBlobUrl;
    archiveResource.codebase.archiveUrl = "codebase.tar.gz";
  }
  const yamlContent = yamlStringify(archiveResource, { lineWidth: 120 });
  const yamlBuf = Buffer.from(yamlContent, "utf-8");
  pack.entry({ name: `${id}/run.yaml`, size: yamlBuf.length }, yamlBuf);

  // Read per-attempt fields from the run sub-document (migration ensures it exists)
  const turns = resource.run?.turns ?? [];
  const topHarUrl = resource.run?.harUrl;
  const topRawChatUrl = resource.run?.rawChatUrl;

  // Entries 2..N: iteration snapshots as-is (.tar.gz blobs)
  for (const turn of turns) {
    if (!turn.snapshotUrl) continue;
    try {
      const blobName = blobNameFromSnapshotsUrl(turn.snapshotUrl);
      if (!blobName) continue;
      const blobClient = container.getBlockBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;
      const entry = pack.entry({
        name: `${id}/iteration-${turn.iteration}.tar.gz`,
        size: downloadResponse.contentLength,
      });
      await pipeline(downloadResponse.readableStreamBody, entry);
    } catch (blobError) {
      if (isBlobNotFound(blobError)) continue;
      throw blobError;
    }
  }

  // Bundle the seeding codebase snapshot (the tar.gz the workspace was seeded
  // from) as `codebase.tar.gz`, so the archive is a self-contained record of
  // the exact starting point the agent worked from.
  const codebaseUrl = resource.codebase?.archiveUrl;
  if (codebaseUrl) {
    try {
      const blobName = blobNameFromSnapshotsUrl(codebaseUrl);
      if (blobName) {
        const blobClient = container.getBlockBlobClient(blobName);
        const downloadResponse = await blobClient.download();
        if (downloadResponse.readableStreamBody && downloadResponse.contentLength) {
          const entry = pack.entry({
            name: `${id}/codebase.tar.gz`,
            size: downloadResponse.contentLength,
          });
          await pipeline(downloadResponse.readableStreamBody, entry);
        }
      }
    } catch (blobError) {
      if (!isBlobNotFound(blobError)) throw blobError;
    }
  }

  // Bundle HAR files into the archive
  const harEntries: Array<{ url: string; entryName: string }> = [];
  for (const turn of turns) {
    if (turn.harUrl) harEntries.push({ url: turn.harUrl, entryName: `${id}/iteration-${turn.iteration}.har` });
  }
  if (topHarUrl) harEntries.push({ url: topHarUrl, entryName: `${id}/run.har` });

  for (const { url, entryName } of harEntries) {
    try {
      const blobName = blobNameFromSnapshotsUrl(url);
      if (!blobName) continue;
      const blobClient = container.getBlockBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;
      const entry = pack.entry({ name: entryName, size: downloadResponse.contentLength });
      await pipeline(downloadResponse.readableStreamBody, entry);
    } catch (blobError) {
      if (isBlobNotFound(blobError)) continue;
      throw blobError;
    }
  }

  // Bundle raw chat export files into the archive
  const chatEntries: Array<{ url: string; entryName: string }> = [];
  for (const turn of turns) {
    if (turn.rawChatUrl) chatEntries.push({ url: turn.rawChatUrl, entryName: `${id}/iteration-${turn.iteration}.chat-export.json` });
  }
  if (topRawChatUrl) chatEntries.push({ url: topRawChatUrl, entryName: `${id}/run.chat-export.json` });

  for (const { url, entryName } of chatEntries) {
    try {
      const blobName = blobNameFromSnapshotsUrl(url);
      if (!blobName) continue;
      const blobClient = container.getBlockBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;
      const entry = pack.entry({ name: entryName, size: downloadResponse.contentLength });
      await pipeline(downloadResponse.readableStreamBody, entry);
    } catch (blobError) {
      if (isBlobNotFound(blobError)) continue;
      throw blobError;
    }
  }

  // Bundle IChatAgentResult2 envelope files into the archive (#811)
  const chatResultEntries: Array<{ url: string; entryName: string }> = [];
  for (const turn of turns) {
    if (turn.chatResultUrl) chatResultEntries.push({ url: turn.chatResultUrl, entryName: `${id}/iteration-${turn.iteration}.chat-result.json` });
  }

  for (const { url, entryName } of chatResultEntries) {
    try {
      const blobName = blobNameFromSnapshotsUrl(url);
      if (!blobName) continue;
      const blobClient = container.getBlockBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;
      const entry = pack.entry({ name: entryName, size: downloadResponse.contentLength });
      await pipeline(downloadResponse.readableStreamBody, entry);
    } catch (blobError) {
      if (isBlobNotFound(blobError)) continue;
      throw blobError;
    }
  }

  // Bundle per-iteration tool-calls JSONL files into the archive.
  // Stored as append blobs in the snapshots container, so use getBlobClient
  // (type-agnostic) — getBlockBlobClient.download() returns contentLength:
  // undefined for append blobs and the entry would be silently skipped.
  for (const turn of turns) {
    if (!turn.toolCallsUrl) continue;
    try {
      const blobName = blobNameFromSnapshotsUrl(turn.toolCallsUrl);
      if (!blobName) continue;
      const blobClient = container.getBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      const { readableStreamBody, contentLength } = downloadResponse;
      if (!readableStreamBody || contentLength == null || contentLength === 0) continue;
      const entry = pack.entry({
        name: `${id}/iteration-${turn.iteration}.tool-calls.jsonl`,
        size: contentLength,
      });
      await pipeline(readableStreamBody, entry);
    } catch (blobError) {
      if (isBlobNotFound(blobError)) continue;
      throw blobError;
    }
  }

  // Bundle per-iteration ATIF trajectory JSON files into the archive.
  for (const turn of turns) {
    if (!turn.atifUrl) continue;
    try {
      const blobName = blobNameFromSnapshotsUrl(turn.atifUrl);
      if (!blobName) continue;
      const blobClient = container.getBlockBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;
      const entry = pack.entry({
        name: `${id}/iteration-${turn.iteration}.atif.trajectory.json`,
        size: downloadResponse.contentLength,
      });
      await pipeline(downloadResponse.readableStreamBody, entry);
    } catch (blobError) {
      if (isBlobNotFound(blobError)) continue;
      throw blobError;
    }
  }

  // Bundle log events (logs.jsonl) from the logs container.
  // Logs are stored as AppendBlobs, so use getBlobClient (type-agnostic) rather
  // than getBlockBlobClient — the latter returns contentLength: undefined for
  // append blobs, causing the entry to be silently skipped.
  if (logsContainer) {
    try {
      // Prefer the per-attempt logsUrl stored on the run sub-document;
      // fall back to legacy path for pre-migration documents.
      const logsUrl = resource.run?.logsUrl;
      const logBlobName = logsUrl
        ? blobNameFromLogsUrl(logsUrl) ?? `${resource._id}/run.jsonl`
        : `${resource._id}/run.jsonl`;
      const blobClient = logsContainer.getBlobClient(logBlobName);
      const downloadResponse = await blobClient.download();
      const { readableStreamBody, contentLength } = downloadResponse;
      if (readableStreamBody && contentLength != null && contentLength > 0) {
        const entry = pack.entry({ name: `${id}/logs.jsonl`, size: contentLength });
        await pipeline(readableStreamBody, entry);
      }
    } catch (blobError) {
      if (!isBlobNotFound(blobError)) throw blobError;
    }
  }
}
