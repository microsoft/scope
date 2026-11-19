// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import type { ResourceDocument, ResourceRevisionDocument } from "../types/resource.js";
import { buildResourceRevisionRef } from "./resource-revision-id.js";
import { ResourceResolver } from "./resource-resolver.js";
import type { CreateResourceRevisionStoreInput, ResourceRevisionStore } from "./resource-revision-store.js";

function makeResource(): ResourceDocument {
  return {
    _id: "resource-1",
    projectId: "proj-test",
    slug: "github-simulator",
    name: "GitHub Simulator",
    revisionCounter: 0,
    createdAt: new Date("2024-01-01T00:00:00Z"),
  };
}

function makeStoreSpy() {
  let revisionNumber = 0;
  const revisions: ResourceRevisionDocument[] = [];
  const createRevision = vi.fn(async (input: CreateResourceRevisionStoreInput): Promise<ResourceRevisionDocument> => {
    revisionNumber += 1;
    const doc: ResourceRevisionDocument = {
      ...input,
      _id: `revision-${revisionNumber}`,
      projectId: "proj-test",
      revisionNumber,
      ref: buildResourceRevisionRef(input.slug, revisionNumber),
      createdAt: new Date(),
    };
    revisions.push(doc);
    return doc;
  });
  const getLatest = vi.fn(async (resourceId: string): Promise<ResourceRevisionDocument | null> => {
    const matching = revisions.filter((revision) => revision.resourceId === resourceId);
    return matching.length ? matching[matching.length - 1] : null;
  });
  return { createRevision, getLatest, store: { createRevision, getLatest } as unknown as ResourceRevisionStore };
}

describe("ResourceResolver", () => {
  it("deduplicates only against the latest normalized lifecycle content", async () => {
    const resource = makeResource();
    const resolver = new ResourceResolver();
    const { createRevision, store } = makeStoreSpy();

    const first = await resolver.createRevision(resource, { setup: { sh: "echo A" }, exports: ["URL"] }, store);
    const second = await resolver.createRevision(resource, { setup: { sh: "echo A" }, exports: ["URL"] }, store);
    const third = await resolver.createRevision(resource, { setup: { sh: "echo B" }, exports: ["URL"] }, store);
    const fourth = await resolver.createRevision(resource, { setup: { sh: "echo A" }, exports: ["URL"] }, store);

    expect(createRevision).toHaveBeenCalledTimes(3);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.revision._id).toBe(first.revision._id);
    expect(third.deduplicated).toBe(false);
    expect(fourth.deduplicated).toBe(false);
    expect(fourth.revision.revisionNumber).toBe(3);
  });

  it("normalizes export order and script object keys before hashing", async () => {
    const resource = makeResource();
    const resolver = new ResourceResolver();
    const { createRevision, store } = makeStoreSpy();

    const first = await resolver.createRevision(
      resource,
      { setup: { sh: "echo ok" }, exports: ["B", "A", "A"] },
      store
    );
    const second = await resolver.createRevision(
      resource,
      { setup: { sh: "echo ok" }, exports: ["A", "B"] },
      store
    );

    expect(createRevision).toHaveBeenCalledTimes(1);
    expect(second.deduplicated).toBe(true);
    expect(second.revision.contentSha256).toBe(first.revision.contentSha256);
  });
});
