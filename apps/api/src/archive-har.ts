// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for bundling run artifacts (snapshots, HARs, chat exports, chat
 * results, tool calls, ATIF trajectories, logs) in run archives.
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

/**
 * Describes a run artifact that archives bundle as `iteration-{N}{suffix}`
 * (and, for some artifacts, a run-level `run{suffix}`). One spec drives
 * detection, upload, and packing, so adding an artifact type is a single
 * table entry instead of three copy-pasted code paths (issue #951).
 */
export interface BundledArtifactSpec {
  /** Archive filename suffix, e.g. `.har` → `iteration-1.har` / `run.har`. */
  suffix: string;
  /** Field holding the blob URL on each turn and, if `hasTopLevel`, on `run`. */
  urlField: "harUrl" | "rawChatUrl" | "chatResultUrl" | "toolCallsUrl" | "atifUrl";
  /** Whether a run-level `run{suffix}` variant exists alongside per-iteration files. */
  hasTopLevel: boolean;
  /** Blob file name under `{runId}/iteration-{N}/` (or `{runId}/` when top-level). */
  blobFileName: string;
  /** Content type set on upload. */
  contentType: string;
  /**
   * `append` artifacts are written as append blobs and must be downloaded via
   * the type-agnostic `getBlobClient` — `getBlockBlobClient().download()`
   * reports `contentLength: undefined` for them, so the entry would be skipped.
   */
  blobType: "block" | "append";
}

/** HAR network capture (per iteration, plus `run.har` for one-shot runs). */
export const HAR_ARTIFACT: BundledArtifactSpec = {
  suffix: ".har",
  urlField: "harUrl",
  hasTopLevel: true,
  blobFileName: "capture.har",
  contentType: "application/json",
  blobType: "block",
};

/** Raw chat export (per iteration, plus `run.chat-export.json`). */
export const CHAT_EXPORT_ARTIFACT: BundledArtifactSpec = {
  suffix: ".chat-export.json",
  urlField: "rawChatUrl",
  hasTopLevel: true,
  blobFileName: "chat-export.json",
  contentType: "application/json",
  blobType: "block",
};

/** IChatAgentResult2 envelope (#811), per iteration only. */
export const CHAT_RESULT_ARTIFACT: BundledArtifactSpec = {
  suffix: ".chat-result.json",
  urlField: "chatResultUrl",
  hasTopLevel: false,
  blobFileName: "chat-result.json",
  contentType: "application/json",
  blobType: "block",
};

/** Captured tool calls JSONL, per iteration only. Live runs write append blobs. */
export const TOOL_CALLS_ARTIFACT: BundledArtifactSpec = {
  suffix: ".tool-calls.jsonl",
  urlField: "toolCallsUrl",
  hasTopLevel: false,
  blobFileName: "tool-calls.jsonl",
  contentType: "application/x-ndjson",
  blobType: "append",
};

/** ATIF trajectory, per iteration only. */
export const ATIF_ARTIFACT: BundledArtifactSpec = {
  suffix: ".atif.trajectory.json",
  urlField: "atifUrl",
  hasTopLevel: false,
  blobFileName: "atif.trajectory.json",
  contentType: "application/json",
  blobType: "block",
};

/**
 * Artifacts bundled into a run archive, in tar entry order. Iteration
 * snapshots, the codebase snapshot, and logs are packed separately because
 * their naming or source container differs.
 */
export const BUNDLED_RUN_ARTIFACTS: readonly BundledArtifactSpec[] = [
  HAR_ARTIFACT,
  CHAT_EXPORT_ARTIFACT,
  CHAT_RESULT_ARTIFACT,
  TOOL_CALLS_ARTIFACT,
  ATIF_ARTIFACT,
];

/** An artifact file found in an extracted archive directory. */
export interface DetectedArtifactFile {
  fileName: string;
  /** Iteration number (for per-turn files), or `null` for the top-level `run{suffix}` file. */
  iteration: number | null;
}

/** Escape a literal string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan filenames for files following an artifact's bundled naming convention:
 * `iteration-{N}{suffix}`, plus `run{suffix}` when the artifact has a
 * top-level variant. Other files are ignored.
 */
export function detectBundledArtifactFiles(
  fileNames: string[],
  spec: BundledArtifactSpec,
): DetectedArtifactFile[] {
  const iterationPattern = new RegExp(`^iteration-(\\d+)${escapeRegExp(spec.suffix)}$`);
  const topLevelName = `run${spec.suffix}`;

  const results: DetectedArtifactFile[] = [];
  for (const name of fileNames) {
    const match = name.match(iterationPattern);
    if (match) {
      results.push({ fileName: name, iteration: parseInt(match[1], 10) });
    } else if (spec.hasTopLevel && name === topLevelName) {
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

/** A run turn whose artifact URL fields can be rewritten after upload. */
type UploadableTurn = { iteration: number; [key: string]: unknown };

/**
 * Upload detected artifact files from an extracted archive directory to blob
 * storage. Per-iteration files go to `{runId}/iteration-{N}/{blobFileName}` and
 * set `turn[spec.urlField]` on the matching turn (mutating `turns`); a
 * top-level file goes to `{runId}/{blobFileName}`.
 *
 * Archived files are always uploaded as block blobs, even for append-blob
 * artifacts: re-imported runs are complete, so append semantics aren't needed.
 *
 * @returns The top-level blob URL, if a top-level file was uploaded.
 */
export async function uploadBundledArtifactFiles(opts: {
  spec: BundledArtifactSpec;
  files: DetectedArtifactFile[];
  runDir: string;
  runId: string;
  turns: UploadableTurn[];
  containerClient: BlobUploader;
}): Promise<string | undefined> {
  const { spec, files, runDir, runId, turns, containerClient } = opts;
  const { join } = await import("node:path");
  let topLevelUrl: string | undefined;

  for (const file of files) {
    const isPerIteration = file.iteration !== null;
    const blobName = isPerIteration
      ? `${runId}/iteration-${file.iteration}/${spec.blobFileName}`
      : `${runId}/${spec.blobFileName}`;
    const tags: Record<string, string> = isPerIteration
      ? { requestId: runId, iteration: String(file.iteration) }
      : { requestId: runId };

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadFile(join(runDir, file.fileName), {
      blobHTTPHeaders: { blobContentType: spec.contentType },
      tags,
    });

    if (isPerIteration) {
      const turn = turns.find(t => t.iteration === file.iteration);
      if (turn) {
        turn[spec.urlField] = blockBlobClient.url;
      }
    } else {
      topLevelUrl = blockBlobClient.url;
    }
  }

  return topLevelUrl;
}

/** Keep only per-iteration files (for artifacts without a top-level variant). */
function perIterationOnly(files: DetectedArtifactFile[]): Array<{ fileName: string; iteration: number }> {
  return files.filter((f): f is { fileName: string; iteration: number } => f.iteration !== null);
}

// ─── Per-artifact wrappers (stable API over the generic helpers) ────────────

/** Describes a HAR file found in an extracted archive directory. */
export type DetectedHarFile = DetectedArtifactFile;

/** Detect `iteration-{N}.har` and `run.har`. */
export function detectBundledHarFiles(fileNames: string[]): DetectedHarFile[] {
  return detectBundledArtifactFiles(fileNames, HAR_ARTIFACT);
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
  const { harFiles, ...rest } = opts;
  return uploadBundledArtifactFiles({ spec: HAR_ARTIFACT, files: harFiles, ...rest });
}

/** Describes a raw chat export file found in an extracted archive directory. */
export type DetectedChatFile = DetectedArtifactFile;

/** Detect `iteration-{N}.chat-export.json` and `run.chat-export.json`. */
export function detectBundledChatFiles(fileNames: string[]): DetectedChatFile[] {
  return detectBundledArtifactFiles(fileNames, CHAT_EXPORT_ARTIFACT);
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
  const { chatFiles, ...rest } = opts;
  return uploadBundledArtifactFiles({ spec: CHAT_EXPORT_ARTIFACT, files: chatFiles, ...rest });
}

/** Describes a per-iteration tool-calls JSONL file found in an extracted archive directory. */
export interface DetectedToolCallsFile {
  fileName: string;
  /** Iteration number — tool-calls JSONL is always per-iteration. */
  iteration: number;
}

/** Detect `iteration-{N}.tool-calls.jsonl`. */
export function detectBundledToolCallsFiles(fileNames: string[]): DetectedToolCallsFile[] {
  return perIterationOnly(detectBundledArtifactFiles(fileNames, TOOL_CALLS_ARTIFACT));
}

/**
 * Upload detected tool-calls JSONL files from an extracted archive directory
 * to blob storage. Mutates each matching turn's `toolCallsUrl` to the new blob URL.
 */
export async function uploadBundledToolCallsFiles(opts: {
  toolCallsFiles: DetectedToolCallsFile[];
  runDir: string;
  runId: string;
  turns: Array<{ iteration: number; toolCallsUrl?: string; [key: string]: unknown }>;
  containerClient: BlobUploader;
}): Promise<void> {
  const { toolCallsFiles, ...rest } = opts;
  await uploadBundledArtifactFiles({ spec: TOOL_CALLS_ARTIFACT, files: toolCallsFiles, ...rest });
}

/** Describes a per-iteration chat-result JSON file found in an extracted archive directory. */
export interface DetectedChatResultFile {
  fileName: string;
  /** Iteration number — chat-result is always per-iteration. */
  iteration: number;
}

/** Detect `iteration-{N}.chat-result.json`. */
export function detectBundledChatResultFiles(fileNames: string[]): DetectedChatResultFile[] {
  return perIterationOnly(detectBundledArtifactFiles(fileNames, CHAT_RESULT_ARTIFACT));
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
  const { chatResultFiles, ...rest } = opts;
  await uploadBundledArtifactFiles({ spec: CHAT_RESULT_ARTIFACT, files: chatResultFiles, ...rest });
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

/** A blob that can be streamed into the archive. */
type DownloadableBlob = ReturnType<BlobDownloader["getBlobClient"]>;

/**
 * Stream one blob into the tar pack as `entryName`.
 *
 * Empty or bodiless downloads are skipped, as are blobs the
 * `isBlobNotFound` predicate recognizes as missing (an archive should still
 * succeed when an optional artifact was never written). Any other error is
 * rethrown.
 */
async function packBlobEntry(
  pack: Pack,
  blob: DownloadableBlob,
  entryName: string,
  isBlobNotFound: (err: unknown) => boolean,
): Promise<void> {
  try {
    const { readableStreamBody, contentLength } = await blob.download();
    if (!readableStreamBody || !contentLength) return;

    const entry = pack.entry({ name: entryName, size: contentLength });
    await pipeline(readableStreamBody, entry);
  } catch (blobError) {
    if (!isBlobNotFound(blobError)) throw blobError;
  }
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

  // Entries 2..N: iteration snapshots as-is (.tar.gz blobs)
  for (const turn of turns) {
    if (!turn.snapshotUrl) continue;
    const blobName = blobNameFromSnapshotsUrl(turn.snapshotUrl);
    if (!blobName) continue;
    await packBlobEntry(pack, container.getBlockBlobClient(blobName), `${id}/iteration-${turn.iteration}.tar.gz`, isBlobNotFound);
  }

  // Bundle the seeding codebase snapshot (the tar.gz the workspace was seeded
  // from) as `codebase.tar.gz`, so the archive is a self-contained record of
  // the exact starting point the agent worked from.
  const codebaseBlobName = codebaseBlobUrl ? blobNameFromSnapshotsUrl(codebaseBlobUrl) : null;
  if (codebaseBlobName) {
    await packBlobEntry(pack, container.getBlockBlobClient(codebaseBlobName), `${id}/codebase.tar.gz`, isBlobNotFound);
  }

  // Bundle per-turn artifacts (and their run-level variants) in table order.
  for (const spec of BUNDLED_RUN_ARTIFACTS) {
    const entries: Array<{ url: string; entryName: string }> = [];
    for (const turn of turns) {
      const url = turn[spec.urlField];
      if (url) entries.push({ url, entryName: `${id}/iteration-${turn.iteration}${spec.suffix}` });
    }
    const topLevelUrl = spec.hasTopLevel ? resource.run?.[spec.urlField] : undefined;
    if (typeof topLevelUrl === "string" && topLevelUrl) {
      entries.push({ url: topLevelUrl, entryName: `${id}/run${spec.suffix}` });
    }

    for (const { url, entryName } of entries) {
      const blobName = blobNameFromSnapshotsUrl(url);
      if (!blobName) continue;
      const blob = spec.blobType === "append"
        ? container.getBlobClient(blobName)
        : container.getBlockBlobClient(blobName);
      await packBlobEntry(pack, blob, entryName, isBlobNotFound);
    }
  }

  // Bundle log events (logs.jsonl) from the logs container.
  // Logs are stored as AppendBlobs, so use getBlobClient (type-agnostic) rather
  // than getBlockBlobClient — the latter returns contentLength: undefined for
  // append blobs, causing the entry to be silently skipped.
  if (logsContainer) {
    // Prefer the per-attempt logsUrl stored on the run sub-document;
    // fall back to legacy path for pre-migration documents.
    const logsUrl = resource.run?.logsUrl;
    const logBlobName = logsUrl
      ? blobNameFromLogsUrl(logsUrl) ?? `${resource._id}/run.jsonl`
      : `${resource._id}/run.jsonl`;
    await packBlobEntry(pack, logsContainer.getBlobClient(logBlobName), `${id}/logs.jsonl`, isBlobNotFound);
  }
}
