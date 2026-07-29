// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { Collection } from "mongodb";
import type { SkillDocument } from "@scope/core";
import type { SkillRevisionStore, SkillResolver } from "@scope/agent-protocol";

/** Parse "slug@commitHash" → { slug, commitHash } or "slug" → { slug } */
export function parseSkillSpec(spec: string): { slug: string; commitHash?: string } {
  const at = spec.lastIndexOf("@");
  if (at > 0) return { slug: spec.substring(0, at), commitHash: spec.substring(at + 1) };
  return { slug: spec };
}

export interface SkillResolveContext {
  skillCollection: Collection<SkillDocument>;
  skillRevisionStore: SkillRevisionStore;
  skillResolver: SkillResolver;
  storageConnectionString: string;
  storageAccountName: string;
}

/**
 * Resolve skill specs (slug or slug@commitHash) to revision refs.
 * - If spec has @commitHash → look up that specific revision
 * - If spec has no hash → resolve to latest revision via skillResolver
 */
export async function resolveSkillSpecs(
  specs: string[],
  ctx: SkillResolveContext,
): Promise<{ refs?: string[]; error?: string }> {
  if (!specs.length) return { refs: [] };

  // Extract unique slugs from specs
  const parsedSpecs = specs.map(parseSkillSpec);
  const slugs = [...new Set(parsedSpecs.map((p) => p.slug))];

  // Validate all slugs exist in DB
  const existingSkills = await ctx.skillCollection
    .find({ _id: { $in: slugs }, deletedAt: { $exists: false } })
    .toArray();
  const existingMap = new Map(existingSkills.map((s: SkillDocument) => [s._id, s]));
  const missing = slugs.filter((slug) => !existingMap.has(slug));
  if (missing.length > 0) {
    return { error: `Skill(s) not found: ${missing.join(", ")}` };
  }

  const uploadArchive = async (archiveName: string, data: Buffer): Promise<string> => {
    if (!ctx.storageConnectionString && !ctx.storageAccountName) {
      throw new Error("Blob storage not configured — cannot store skill archives");
    }
    let blobServiceClient: BlobServiceClient;
    if (ctx.storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
    } else {
      const credential = new DefaultAzureCredential();
      blobServiceClient = new BlobServiceClient(
        `https://${ctx.storageAccountName}.blob.core.windows.net`,
        credential
      );
    }
    const containerClient = blobServiceClient.getContainerClient("skill-archives");
    await containerClient.createIfNotExists();
    const blockBlobClient = containerClient.getBlockBlobClient(archiveName);
    await blockBlobClient.upload(data, data.length, {
      blobHTTPHeaders: { blobContentType: "application/gzip" },
    });
    return blockBlobClient.url;
  };

  const refs: string[] = [];
  for (const { slug, commitHash } of parsedSpecs) {
    const skill = existingMap.get(slug)!;
    if (commitHash) {
      // Pinned to specific revision — validate it exists
      const ref = `${slug}@${commitHash}`;
      const revision = await ctx.skillRevisionStore.getByRef(ref);
      if (!revision) {
        return { error: `Skill revision not found: ${ref}` };
      }
      refs.push(revision.ref);
    } else {
      // Resolve to latest revision
      try {
        const revision = await ctx.skillResolver.resolve(
          skill.source,
          skill.skillName,
          ctx.skillRevisionStore,
          uploadArchive,
        );
        refs.push(revision.ref);
      } catch (resolveError) {
        return { error: `Failed to resolve skill "${skill._id}": ${resolveError instanceof Error ? resolveError.message : String(resolveError)}` };
      }
    }
  }
  return { refs };
}
