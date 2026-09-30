// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "crypto";
import type {
  ResourceConfig,
  ResourceDocument,
  ResourceParameter,
  ResourceRevisionDocument,
  ResourceScript,
} from "../types/resource.js";
import type { ResourceRevisionStore } from "./resource-revision-store.js";
import type { ResourceStore } from "./resource-store.js";
import { parseResourceRevisionRef } from "./resource-revision-id.js";

export interface CreateResourceRevisionInput {
  setup: ResourceScript;
  teardown?: ResourceScript;
  exports?: string[];
  parameters?: ResourceParameter[];
  creator?: string;
}

export interface ResolveResourceRevisionResult {
  revision: ResourceRevisionDocument;
  deduplicated: boolean;
}

interface NormalizedResourceRevisionContent {
  setup: ResourceScript;
  teardown?: ResourceScript;
  exports: string[];
  parameters?: ResourceParameter[];
}

function normalizeScript(script: ResourceScript): ResourceScript {
  const entries = Object.entries(script)
    .filter(([, body]) => typeof body === "string" && body.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries) as ResourceScript;
}

/**
 * Order parameters by name and drop absent optional fields so that two
 * declarations differing only in key order or in `undefined` vs missing hash
 * identically. Without this, re-saving an unchanged resource through a client
 * that serializes keys differently would mint a pointless revision.
 */
function normalizeParameters(parameters: ResourceParameter[]): ResourceParameter[] {
  return [...parameters]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      name: p.name,
      required: p.required,
      ...(p.description ? { description: p.description } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.example !== undefined ? { example: p.example } : {}),
    }));
}

export function normalizeResourceRevisionContent(
  input: CreateResourceRevisionInput
): NormalizedResourceRevisionContent {
  const setup = normalizeScript(input.setup);
  const teardown = input.teardown ? normalizeScript(input.teardown) : undefined;
  const exports = [...new Set(input.exports ?? [])].sort((a, b) => a.localeCompare(b));
  const parameters = input.parameters?.length ? normalizeParameters(input.parameters) : undefined;
  return {
    setup,
    ...(teardown && Object.keys(teardown).length > 0 ? { teardown } : {}),
    exports,
    // Omitted entirely when empty so that revisions created before parameters
    // existed keep hashing to the same value as an equivalent parameterless save.
    ...(parameters ? { parameters } : {}),
  };
}

export function hashResourceRevisionContent(content: NormalizedResourceRevisionContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export class ResourceResolver {
  /**
   * Create a lifecycle revision unless its normalized setup/teardown/exports are
   * identical to the current latest revision.
   */
  async createRevision(
    resource: ResourceDocument,
    input: CreateResourceRevisionInput,
    store: ResourceRevisionStore
  ): Promise<ResolveResourceRevisionResult> {
    const normalized = normalizeResourceRevisionContent(input);
    const contentSha256 = hashResourceRevisionContent(normalized);

    // Dedup: if the latest revision already has this exact normalized lifecycle
    // hash, reuse it instead of creating a redundant revision.
    //
    // Known tradeoff (best-effort, not transactional): two concurrent saves of
    // the same lifecycle can both miss this check and each create a revision,
    // leaving two identical snapshots. This is benign — revisions are immutable
    // and either one provisions the same resource — so we accept the rare
    // duplicate rather than add a unique index (awkward with soft-deleted refs
    // and the requirement to dedup only against the latest revision). Sequential
    // re-saves dedup correctly.
    const latest = await store.getLatest(resource._id);
    if (latest && latest.contentSha256 === contentSha256) {
      return { revision: latest, deduplicated: true };
    }

    const revision = await store.createRevision({
      resourceId: resource._id,
      slug: resource.slug,
      setup: normalized.setup,
      ...(normalized.teardown ? { teardown: normalized.teardown } : {}),
      exports: normalized.exports,
      ...(normalized.parameters ? { parameters: normalized.parameters } : {}),
      contentSha256,
      ...(input.creator ? { creator: input.creator } : {}),
    });
    return { revision, deduplicated: false };
  }

  /** Resolve a resource spec (slug, `{slug}@rN`, or revision id) to a config. */
  async resolveSpec(
    projectId: string,
    spec: string,
    stores: { resourceStore: ResourceStore; resourceRevisionStore: ResourceRevisionStore }
  ): Promise<{ config?: ResourceConfig; revision?: ResourceRevisionDocument; error?: string }> {
    const trimmed = spec.trim();
    if (!trimmed) return { error: "Empty resource spec" };

    const parsed = parseResourceRevisionRef(trimmed);
    let revision: ResourceRevisionDocument | null = null;
    let resource: ResourceDocument | null = null;

    if (parsed && parsed.revisionNumber !== undefined) {
      revision = await stores.resourceRevisionStore.getByRef(projectId, trimmed);
    } else {
      revision = await stores.resourceRevisionStore.get(trimmed);
      if (revision && revision.projectId !== projectId) revision = null;
    }

    if (!revision && parsed && parsed.revisionNumber === undefined) {
      resource = await stores.resourceStore.getBySlug(projectId, parsed.slug);
      if (!resource) return { error: `Resource not found: ${trimmed}` };
      revision = await stores.resourceRevisionStore.getLatest(resource._id);
    }

    if (!revision) return { error: `Resource revision not found: ${trimmed}` };
    resource ??= await stores.resourceStore.get(revision.resourceId, { includeDeleted: true });

    const config: ResourceConfig = {
      ref: revision.ref,
      resourceId: revision.resourceId,
      revisionId: revision._id,
      slug: revision.slug,
      name: resource?.name ?? revision.slug,
      setup: revision.setup,
      ...(revision.teardown ? { teardown: revision.teardown } : {}),
      exports: revision.exports ?? [],
    };
    return { config, revision };
  }
}
