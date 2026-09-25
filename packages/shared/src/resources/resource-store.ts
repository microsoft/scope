// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import { randomUUID } from "crypto";
import type { ResourceDocument } from "../types/resource.js";
import { slugifyResourceName } from "./resource-revision-id.js";

/** Input for creating a new resource entity. */
export interface CreateResourceInput {
  projectId: string;
  name: string;
  slug?: string;
  description?: string;
  creator?: string;
}

/** Mutable fields that can be patched on a resource. */
export interface UpdateResourceInput {
  name?: string;
  description?: string;
}

/** MongoDB-backed store for the mutable `resources` collection. */
export class ResourceStore {
  constructor(private collection: Collection<ResourceDocument>) {}

  /** Get a resource by its UUID `_id` (excludes soft-deleted by default). */
  async get(id: string, opts?: { includeDeleted?: boolean }): Promise<ResourceDocument | null> {
    const filter: Record<string, unknown> = { _id: id };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection.findOne(filter as object) as Promise<ResourceDocument | null>;
  }

  /** Get a resource by project-scoped slug (excludes soft-deleted by default). */
  async getBySlug(
    projectId: string,
    slug: string,
    opts?: { includeDeleted?: boolean }
  ): Promise<ResourceDocument | null> {
    const filter: Record<string, unknown> = { projectId, slug };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection.findOne(filter as object) as Promise<ResourceDocument | null>;
  }

  /** List resources, newest first (excludes soft-deleted by default). */
  async list(opts: { projectId: string; includeDeleted?: boolean }): Promise<ResourceDocument[]> {
    const filter: Record<string, unknown> = { projectId: opts.projectId };
    if (!opts.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection.find(filter).sort({ createdAt: -1 }).toArray();
  }

  /** Create a resource and initialize its revision counter at 0. */
  async create(input: CreateResourceInput): Promise<ResourceDocument> {
    const slug = slugifyResourceName(input.slug ?? input.name);
    if (!slug) {
      throw new Error("Could not derive a valid slug from the resource name");
    }

    const doc: ResourceDocument = {
      _id: randomUUID(),
      projectId: input.projectId,
      slug,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      revisionCounter: 0,
      ...(input.creator ? { creator: input.creator } : {}),
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc as ResourceDocument);
    return doc;
  }

  /** Patch mutable metadata. Returns the updated document, or null if not found. */
  async update(id: string, patch: UpdateResourceInput): Promise<ResourceDocument | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;

    const result = await this.collection.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } } as object,
      { $set: set },
      { returnDocument: "after" }
    );
    return (result as ResourceDocument | null) ?? null;
  }

  /** Soft-delete a resource (sets `deletedAt`). Returns true if a doc was updated. */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } } as object,
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  /** Hard-delete a resource; intended only for create rollback. */
  async hardDelete(id: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: id } as object);
    return result.deletedCount > 0;
  }

  /** Atomically allocate the next revision number for a resource. */
  async allocateRevisionNumber(resourceId: string): Promise<number | null> {
    const result = await this.collection.findOneAndUpdate(
      { _id: resourceId, deletedAt: { $exists: false } } as object,
      { $inc: { revisionCounter: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    const doc = result as ResourceDocument | null;
    return doc ? doc.revisionCounter : null;
  }

  /** Advance the denormalized latest pointer without allowing it to regress. */
  async setLatestRevision(
    resourceId: string,
    revisionId: string,
    revisionNumber: number
  ): Promise<void> {
    await this.collection.updateOne(
      {
        _id: resourceId,
        $or: [
          { latestRevisionNumber: { $exists: false } },
          { latestRevisionNumber: { $lt: revisionNumber } },
        ],
      } as object,
      {
        $set: {
          latestRevisionId: revisionId,
          latestRevisionNumber: revisionNumber,
          updatedAt: new Date(),
        },
      }
    );
  }
}
