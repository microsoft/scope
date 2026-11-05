// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import {
  parseCodebaseRevisionRef,
  type CodebaseStore,
  type CodebaseRevisionStore,
  type CodebaseResolver,
} from "shared";

/** The blob container shared by skill archives, run snapshots, and codebases. */
export const CODEBASE_BLOB_CONTAINER = "snapshots";

export interface CodebaseBlobConfig {
  storageConnectionString: string;
  storageAccountName: string;
}

function getBlobServiceClient(cfg: CodebaseBlobConfig): BlobServiceClient {
  if (cfg.storageConnectionString) {
    return BlobServiceClient.fromConnectionString(cfg.storageConnectionString);
  }
  if (cfg.storageAccountName) {
    const credential = new DefaultAzureCredential();
    return new BlobServiceClient(
      `https://${cfg.storageAccountName}.blob.core.windows.net`,
      credential
    );
  }
  throw new Error("Blob storage not configured — cannot store codebase archives");
}

/**
 * Build an `uploadArchive(blobName, data)` function for codebase revision
 * archives. The blob name is the full key the resolver computes
 * (`codebase-revisions/{codebaseId}/{revisionId}.tar.gz`); this uploads it into
 * the shared `snapshots` container and returns the blob URL.
 */
export function createCodebaseArchiveUploader(
  cfg: CodebaseBlobConfig
): (blobName: string, data: Buffer) => Promise<string> {
  return async (blobName: string, data: Buffer): Promise<string> => {
    const blobServiceClient = getBlobServiceClient(cfg);
    const containerClient = blobServiceClient.getContainerClient(CODEBASE_BLOB_CONTAINER);
    await containerClient.createIfNotExists();
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.upload(data, data.length, {
      blobHTTPHeaders: { blobContentType: "application/gzip" },
    });
    return blockBlobClient.url;
  };
}

/**
 * Download a codebase revision archive directly from blob storage given its
 * `archiveUrl`. Returns the tar.gz bytes. Used by the archive-download proxy.
 */
export async function downloadCodebaseArchive(
  archiveUrl: string,
  cfg: CodebaseBlobConfig
): Promise<Buffer> {
  const url = new URL(archiveUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const containerIdx = pathParts.indexOf(CODEBASE_BLOB_CONTAINER);
  if (containerIdx === -1 || containerIdx >= pathParts.length - 1) {
    throw new Error("Cannot parse codebase archive blob path");
  }
  const blobName = pathParts.slice(containerIdx + 1).join("/");

  const blobServiceClient = getBlobServiceClient(cfg);
  const containerClient = blobServiceClient.getContainerClient(CODEBASE_BLOB_CONTAINER);
  const blobClient = containerClient.getBlobClient(blobName);
  return blobClient.downloadToBuffer();
}

export interface CodebaseSpecResolveContext {
  projectId: string;
  codebaseStore: CodebaseStore;
  codebaseRevisionStore: CodebaseRevisionStore;
  codebaseResolver: CodebaseResolver;
  uploadArchive: (blobName: string, data: Buffer) => Promise<string>;
  creator?: string;
}

/**
 * Resolve a codebase spec given at run-submission time into a concrete revision id.
 *
 * Accepted forms:
 * - a raw revision UUID (`_id`) → validated as-is.
 * - `{slug}@r{N}` → looked up by ref.
 * - `{slug}` → latest revision. For an archive codebase this is `latestRevisionId`
 *   (must already exist). For a git codebase this resolves the default branch and
 *   creates a NEW incremental revision at submit time.
 */
export async function resolveCodebaseSpec(
  spec: string,
  ctx: CodebaseSpecResolveContext
): Promise<{ revisionId?: string; ref?: string; error?: string }> {
  const trimmed = spec.trim();
  if (!trimmed) return { error: "Empty codebase spec" };

  // 1) `{slug}@r{N}` ref.
  const parsed = parseCodebaseRevisionRef(trimmed);
  if (parsed && parsed.revisionNumber !== undefined) {
    const revision = await ctx.codebaseRevisionStore.getByRef(ctx.projectId, trimmed);
    if (!revision || revision.projectId !== ctx.projectId) return { error: `Codebase revision not found: ${trimmed}` };
    return { revisionId: revision._id, ref: revision.ref };
  }

  // 2) Raw revision id (UUID).
  const byId = await ctx.codebaseRevisionStore.get(trimmed);
  if (byId) {
    if (byId.projectId !== ctx.projectId) return { error: "Codebase revision not found" };
    return { revisionId: byId._id, ref: byId.ref };
  }

  // 3) Bare slug → latest (archive) or resolve-at-submit (git).
  const codebase = await ctx.codebaseStore.getBySlug(ctx.projectId, trimmed);
  if (!codebase || codebase.projectId !== ctx.projectId) return { error: `Codebase not found: ${trimmed}` };

  if (codebase.sourceType === "git") {
    try {
      const { revision } = await ctx.codebaseResolver.resolveGit(
        codebase,
        codebase.defaultBranch,
        ctx.codebaseRevisionStore,
        ctx.uploadArchive,
        ctx.creator ? { creator: ctx.creator } : undefined
      );
      return { revisionId: revision._id, ref: revision.ref };
    } catch (err) {
      return {
        error: `Failed to resolve git codebase "${codebase.slug}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Archive codebase — must have an existing revision.
  const latest = await ctx.codebaseRevisionStore.getLatest(codebase._id);
  if (!latest || latest.projectId !== ctx.projectId || latest.codebaseId !== codebase._id) {
    return { error: `Codebase "${codebase.slug}" has no revisions — upload an archive first` };
  }
  return { revisionId: latest._id, ref: latest.ref };
}
