// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import { randomUUID } from "crypto";
import type { CodebaseRevisionDocument } from "../types/codebase.js";
import type { CodebaseStore } from "./codebase-store.js";
import {
  buildCodebaseRevisionRef,
  parseCodebaseRevisionRef,
} from "./codebase-revision-id.js";

/**
 * Fields the caller supplies when creating a revision. The generated fields
 * (`_id`, `revisionNumber`, `ref`, `createdAt`) are assigned by the store.
 */
export type CreateCodebaseRevisionInput = Omit<
  CodebaseRevisionDocument,
  "_id" | "revisionNumber" | "ref" | "createdAt" | "projectId"
>;

/**
 * MongoDB-backed store for the immutable `codebase-revisions` collection.
 *
 * Revisions are **purely incremental**: every call to {@link createRevision}
 * allocates the next `revisionNumber` (via the codebase's atomic counter) and
 * inserts a brand-new immutable document. There is no deduplication — uploading
 * identical bytes or re-resolving the same git SHA still creates a new revision.
 * Existing revisions are never mutated.
 */
export class CodebaseRevisionStore {
  constructor(
    private collection: Collection<CodebaseRevisionDocument>,
    private codebaseStore: CodebaseStore
  ) {}

  /** Get a revision by its UUID `_id`. */
  async get(id: string): Promise<CodebaseRevisionDocument | null> {
    return this.collection.findOne({ _id: id });
  }

  /** Get a revision by its canonical `{slug}@r{N}` ref. */
  async getByRef(projectId: string, ref: string): Promise<CodebaseRevisionDocument | null> {
    const parsed = parseCodebaseRevisionRef(ref);
    if (!parsed || parsed.revisionNumber === undefined) return null;
    return this.collection.findOne({
      projectId,
      slug: parsed.slug,
      revisionNumber: parsed.revisionNumber,
    });
  }

  /** Get a specific revision number within a codebase. */
  async getByNumber(
    codebaseId: string,
    revisionNumber: number
  ): Promise<CodebaseRevisionDocument | null> {
    return this.collection.findOne({ codebaseId, revisionNumber });
  }

  /** Get the latest (highest-numbered) revision for a codebase, or null. */
  async getLatest(
    codebaseId: string,
    opts?: { includeDeleted?: boolean }
  ): Promise<CodebaseRevisionDocument | null> {
    const filter: Record<string, unknown> = { codebaseId };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    const [latest] = await this.collection
      .find(filter as object)
      .sort({ revisionNumber: -1 })
      .limit(1)
      .toArray();
    return latest ?? null;
  }

  /** List revisions for a codebase, newest first (excludes soft-deleted by default). */
  async listByCodebase(
    codebaseId: string,
    opts?: { limit?: number; includeDeleted?: boolean }
  ): Promise<CodebaseRevisionDocument[]> {
    const filter: Record<string, unknown> = { codebaseId };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection
      .find(filter as object)
      .sort({ revisionNumber: -1 })
      .limit(opts?.limit ?? 100)
      .toArray();
  }

  /**
   * Create a new immutable revision. Atomically allocates the next
   * `revisionNumber` from the parent codebase, builds the `{slug}@r{N}` ref,
   * inserts the document, and advances the codebase's `latestRevisionId`.
   *
   * @param input - revision content (provenance, archive URL, metadata).
   * @param opts.id - optional pre-assigned `_id`. Callers that name the blob
   *   after the revision id (the standard convention) generate the UUID up
   *   front and pass it here so the stored `_id` matches the blob key.
   * @throws if the parent codebase does not exist (or was deleted).
   */
  async createRevision(
    input: CreateCodebaseRevisionInput,
    opts?: { id?: string }
  ): Promise<CodebaseRevisionDocument> {
    // Derive the project scope from the parent codebase (child entities copy
    // their parent's projectId — they are never passed one directly).
    const codebase = await this.codebaseStore.get(input.codebaseId);
    if (!codebase) {
      throw new Error(`Codebase '${input.codebaseId}' not found — cannot create revision`);
    }
    const revisionNumber = await this.codebaseStore.allocateRevisionNumber(
      input.codebaseId
    );
    if (revisionNumber === null) {
      throw new Error(`Codebase '${input.codebaseId}' not found — cannot create revision`);
    }

    const doc: CodebaseRevisionDocument = {
      ...input,
      _id: opts?.id ?? randomUUID(),
      projectId: codebase.projectId,
      revisionNumber,
      ref: buildCodebaseRevisionRef(input.slug, revisionNumber),
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc as CodebaseRevisionDocument);
    await this.codebaseStore.setLatestRevision(
      input.codebaseId,
      doc._id,
      doc.revisionNumber
    );
    return doc;
  }

  /**
   * Soft-delete all revisions for a codebase by setting `deletedAt`. Used when a
   * codebase is soft-deleted so its revision history is hidden from listings but
   * the immutable snapshot data is preserved (runs that reference a specific
   * `codebaseRevisionId` still resolve via {@link get}/{@link getByRef}).
   *
   * @returns the number of revisions newly soft-deleted.
   */
  async softDeleteByCodebase(codebaseId: string): Promise<number> {
    const result = await this.collection.updateMany(
      { codebaseId, deletedAt: { $exists: false } } as object,
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  /**
   * Hard-delete all revisions for a codebase. Permanently removes revision data;
   * intended only for rollback of a just-created codebase (e.g. an atomic
   * archive-create that failed) — not for normal deletion, which soft-deletes.
   *
   * @returns the number of deleted revision documents.
   */
  async deleteByCodebase(codebaseId: string): Promise<number> {
    const result = await this.collection.deleteMany({ codebaseId });
    return result.deletedCount;
  }
}
