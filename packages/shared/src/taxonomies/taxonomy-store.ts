// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import type {
  TaxonomyDocument,
  TaxonomyElementDocument,
  TaxonomySourceType,
} from "../types/taxonomy.js";

type RootDocument = TaxonomyDocument | TaxonomyElementDocument;

export interface CreateTaxonomyRootInput {
  projectId: string;
  id: string;
  name: string;
  description?: string;
  sourceType: TaxonomySourceType;
  creator?: string;
}

/** Store for one mutable taxonomy root collection. */
export class TaxonomyRootStore<T extends RootDocument> {
  constructor(private readonly collection: Collection<T>) {}

  async get(id: string, includeDeleted = false): Promise<T | null> {
    return this.collection.findOne({
      _id: id,
      ...(includeDeleted ? {} : { deletedAt: { $exists: false } }),
    } as never) as Promise<T | null>;
  }

  async list(projectId: string, includeDeleted = false): Promise<T[]> {
    return this.collection
      .find({
        projectId,
        ...(includeDeleted ? {} : { deletedAt: { $exists: false } }),
      } as never)
      .sort({ createdAt: -1 })
      .toArray() as Promise<T[]>;
  }

  async getMany(ids: readonly string[], includeDeleted = false): Promise<T[]> {
    if (ids.length === 0) return [];
    return this.collection
      .find({
        _id: { $in: [...new Set(ids)] },
        ...(includeDeleted ? {} : { deletedAt: { $exists: false } }),
      } as never)
      .toArray() as Promise<T[]>;
  }

  async getByBusinessId(
    projectId: string,
    id: string,
    includeDeleted = false,
  ): Promise<T | null> {
    return this.collection.findOne({
      projectId,
      id,
      ...(includeDeleted ? {} : { deletedAt: { $exists: false } }),
    } as never) as Promise<T | null>;
  }

  async create(input: CreateTaxonomyRootInput): Promise<T> {
    const now = new Date();
    const document = {
      _id: randomUUID(),
      projectId: input.projectId,
      id: input.id,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      sourceType: input.sourceType,
      revisionCounter: 0,
      ...(input.creator ? { creator: input.creator } : {}),
      createdAt: now,
    } as T;
    await this.collection.insertOne(document as never);
    return document;
  }

  async updateMetadata(
    id: string,
    patch: { name?: string; description?: string },
  ): Promise<T | null> {
    return this.collection.findOneAndUpdate(
      { _id: id, sourceType: "user", deletedAt: { $exists: false } } as never,
      {
        $set: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          updatedAt: new Date(),
        },
      } as never,
      { returnDocument: "after" },
    ) as Promise<T | null>;
  }

  async allocateRevision(id: string): Promise<T | null> {
    return this.collection.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } } as never,
      { $inc: { revisionCounter: 1 }, $set: { updatedAt: new Date() } } as never,
      { returnDocument: "after" },
    ) as Promise<T | null>;
  }

  async setLatest(id: string, revisionId: string, revision: number): Promise<void> {
    await this.collection.updateOne(
      {
        _id: id,
        $or: [
          { latestRevision: { $exists: false } },
          { latestRevision: { $lt: revision } },
        ],
      } as never,
      {
        $set: {
          latestRevisionId: revisionId,
          latestRevision: revision,
          updatedAt: new Date(),
        },
      } as never,
    );
  }

  async softDelete(id: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id, sourceType: "user", deletedAt: { $exists: false } } as never,
      { $set: { deletedAt: new Date(), updatedAt: new Date() } } as never,
    );
    return result.modifiedCount === 1;
  }

  async restore(id: string): Promise<T | null> {
    return this.collection.findOneAndUpdate(
      { _id: id, sourceType: "user", deletedAt: { $exists: true } } as never,
      { $unset: { deletedAt: "" }, $set: { updatedAt: new Date() } } as never,
      { returnDocument: "after" },
    ) as Promise<T | null>;
  }
}
