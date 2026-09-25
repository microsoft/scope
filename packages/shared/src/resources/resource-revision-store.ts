// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import { randomUUID } from "crypto";
import type { ResourceRevisionDocument } from "../types/resource.js";
import type { ResourceStore } from "./resource-store.js";
import { buildResourceRevisionRef, parseResourceRevisionRef } from "./resource-revision-id.js";

/** Fields the caller supplies when creating a resource revision. */
export type CreateResourceRevisionStoreInput = Omit<
  ResourceRevisionDocument,
  "_id" | "revisionNumber" | "ref" | "createdAt" | "projectId"
>;

/** MongoDB-backed store for immutable `resource-revisions` documents. */
export class ResourceRevisionStore {
  constructor(
    private collection: Collection<ResourceRevisionDocument>,
    private resourceStore: ResourceStore
  ) {}

  /** Get a revision by UUID `_id`, including soft-deleted revisions. */
  async get(id: string): Promise<ResourceRevisionDocument | null> {
    return this.collection.findOne({ _id: id });
  }

  /** Get a revision by canonical `{slug}@r{N}` ref within a project. */
  async getByRef(projectId: string, ref: string): Promise<ResourceRevisionDocument | null> {
    const parsed = parseResourceRevisionRef(ref);
    if (!parsed || parsed.revisionNumber === undefined) return null;
    return this.collection.findOne({
      projectId,
      slug: parsed.slug,
      revisionNumber: parsed.revisionNumber,
    });
  }

  /** Get a specific revision number within a resource. */
  async getByNumber(
    resourceId: string,
    revisionNumber: number
  ): Promise<ResourceRevisionDocument | null> {
    return this.collection.findOne({ resourceId, revisionNumber });
  }

  /** Get the latest (highest-numbered) revision for a resource, or null. */
  async getLatest(
    resourceId: string,
    opts?: { includeDeleted?: boolean }
  ): Promise<ResourceRevisionDocument | null> {
    const filter: Record<string, unknown> = { resourceId };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    const [latest] = await this.collection
      .find(filter as object)
      .sort({ revisionNumber: -1 })
      .limit(1)
      .toArray();
    return latest ?? null;
  }

  /** List revisions for a resource, newest first (excludes soft-deleted by default). */
  async listByResource(
    resourceId: string,
    opts?: { limit?: number; includeDeleted?: boolean }
  ): Promise<ResourceRevisionDocument[]> {
    const filter: Record<string, unknown> = { resourceId };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection
      .find(filter as object)
      .sort({ revisionNumber: -1 })
      .limit(opts?.limit ?? 100)
      .toArray();
  }

  /**
   * Create a new immutable revision, assigning the next per-resource revision
   * number via the parent resource's atomic counter and guarding the latest
   * pointer against stale concurrent writers.
   */
  async createRevision(input: CreateResourceRevisionStoreInput): Promise<ResourceRevisionDocument> {
    const resource = await this.resourceStore.get(input.resourceId);
    if (!resource) {
      throw new Error(`Resource '${input.resourceId}' not found — cannot create revision`);
    }
    const revisionNumber = await this.resourceStore.allocateRevisionNumber(input.resourceId);
    if (revisionNumber === null) {
      throw new Error(`Resource '${input.resourceId}' not found — cannot create revision`);
    }

    const doc: ResourceRevisionDocument = {
      ...input,
      _id: randomUUID(),
      projectId: resource.projectId,
      revisionNumber,
      ref: buildResourceRevisionRef(input.slug, revisionNumber),
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc as ResourceRevisionDocument);
    await this.resourceStore.setLatestRevision(input.resourceId, doc._id, doc.revisionNumber);
    return doc;
  }

  /** Soft-delete all revisions for a resource by setting `deletedAt`. */
  async softDeleteByResource(resourceId: string): Promise<number> {
    const result = await this.collection.updateMany(
      { resourceId, deletedAt: { $exists: false } } as object,
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  /** Hard-delete all revisions for a resource; intended only for create rollback. */
  async deleteByResource(resourceId: string): Promise<number> {
    const result = await this.collection.deleteMany({ resourceId });
    return result.deletedCount;
  }
}
