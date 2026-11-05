// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import { randomUUID } from "crypto";
import type { CodebaseDocument, CodebaseSourceType } from "../types/codebase.js";
import { slugifyCodebaseName } from "./codebase-revision-id.js";

/**
 * True if `error` is a MongoDB duplicate-key error (E11000) caused by the unique
 * `slug` index — i.e. a concurrent create grabbed the same slug first.
 */
function isSlugDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  if (e.code !== 11000) return false;
  // Prefer the structured keyPattern; fall back to the message for drivers/mocks
  // that omit it.
  if (e.keyPattern) return "slug" in e.keyPattern;
  return typeof e.message === "string" && e.message.includes("slug");
}

/** Input for creating a new codebase entity. */
export interface CreateCodebaseInput {
  projectId: string;
  name: string;
  slug?: string;
  description?: string;
  sourceType: CodebaseSourceType;
  source?: string;
  defaultBranch?: string;
  creator?: string;
}

/** Mutable fields that can be patched on a codebase. */
export interface UpdateCodebaseInput {
  name?: string;
  description?: string;
  defaultBranch?: string;
}

/**
 * MongoDB-backed store for the mutable `codebases` collection.
 *
 * Owns slug uniqueness, soft delete, the atomic per-codebase revision counter,
 * and the `latestRevisionId` pointer. Revision snapshots live in the immutable
 * `codebase-revisions` collection (see {@link CodebaseRevisionStore}).
 */
export class CodebaseStore {
  constructor(private collection: Collection<CodebaseDocument>) {}

  /** Get a codebase by its UUID `_id` (excludes soft-deleted by default). */
  async get(id: string, opts?: { includeDeleted?: boolean }): Promise<CodebaseDocument | null> {
    const filter: Record<string, unknown> = { _id: id };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection.findOne(filter as object) as Promise<CodebaseDocument | null>;
  }

  /** Get a codebase by its project-local slug (excludes soft-deleted by default). */
  async getBySlug(projectId: string, slug: string, opts?: { includeDeleted?: boolean }): Promise<CodebaseDocument | null> {
    const filter: Record<string, unknown> = { projectId, slug };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection.findOne(filter as object) as Promise<CodebaseDocument | null>;
  }

  /** List codebases, newest first (excludes soft-deleted by default). */
  async list(opts?: { includeDeleted?: boolean; projectId?: string }): Promise<CodebaseDocument[]> {
    const filter: Record<string, unknown> = opts?.includeDeleted ? {} : { deletedAt: { $exists: false } };
    if (opts?.projectId) {
      filter.projectId = opts.projectId;
    }
    return this.collection.find(filter).sort({ createdAt: -1 }).toArray();
  }

  /**
   * Create a new codebase. Generates a fresh UUID `_id`, derives/validates a
   * unique slug, and initializes the revision counter at 0.
   *
   * @throws if the resolved slug already exists, or if a git codebase is
   *         created without a `source`.
   */
  async create(input: CreateCodebaseInput): Promise<CodebaseDocument> {
    if (input.sourceType === "git" && !input.source?.trim()) {
      throw new Error("Git codebases require a 'source' (owner/repo)");
    }

    const baseSlug = slugifyCodebaseName(input.slug ?? input.name);
    if (!baseSlug) {
      throw new Error("Could not derive a valid slug from the codebase name");
    }

    const now = new Date();
    // `ensureUniqueSlug` + insert is check-then-act: two concurrent creates with
    // the same name can both pass the check, then one insert loses the race on
    // the unique slug index (E11000). Retry a few times, re-deriving the slug.
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const slug = await this.ensureUniqueSlug(input.projectId, baseSlug);
      const doc: CodebaseDocument = {
        _id: randomUUID(),
        projectId: input.projectId,
        slug,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        sourceType: input.sourceType,
        ...(input.source ? { source: input.source } : {}),
        ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
        revisionCounter: 0,
        ...(input.creator ? { creator: input.creator } : {}),
        createdAt: now,
      };

      try {
        // eslint-disable-next-line no-await-in-loop
        await this.collection.insertOne(doc as CodebaseDocument);
        return doc;
      } catch (error) {
        if (isSlugDuplicateKeyError(error) && attempt < maxAttempts) {
          continue;
        }
        throw error;
      }
    }
    // Unreachable: the loop either returns or throws.
    throw new Error(`Could not allocate a unique slug for '${baseSlug}'`);
  }

  /** Patch mutable metadata. Returns the updated document, or null if not found. */
  async update(id: string, patch: UpdateCodebaseInput): Promise<CodebaseDocument | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.defaultBranch !== undefined) set.defaultBranch = patch.defaultBranch;

    const result = await this.collection.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } } as object,
      { $set: set },
      { returnDocument: "after" }
    );
    return (result as CodebaseDocument | null) ?? null;
  }

  /** Soft-delete a codebase (sets `deletedAt`). Returns true if a doc was updated. */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } } as object,
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Hard-delete a codebase, permanently removing the document (and freeing its
   * slug). Unlike {@link softDelete}, this does not reserve the slug, so it is
   * intended only for rollback of a just-created codebase that has no revisions
   * or runs referencing it (e.g. when an atomic archive-create fails after the
   * codebase row was inserted).
   *
   * @returns true if a document was deleted.
   */
  async hardDelete(id: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: id } as object);
    return result.deletedCount > 0;
  }

  /**
   * Atomically allocate the next revision number for a codebase by `$inc`-ing
   * its `revisionCounter`. Concurrent callers receive distinct, gap-free numbers.
   *
   * @returns the newly allocated revision number, or null if the codebase is gone.
   */
  async allocateRevisionNumber(codebaseId: string): Promise<number | null> {
    const result = await this.collection.findOneAndUpdate(
      { _id: codebaseId, deletedAt: { $exists: false } } as object,
      { $inc: { revisionCounter: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    const doc = result as CodebaseDocument | null;
    return doc ? doc.revisionCounter : null;
  }

  /**
   * Advance the convenience `latestRevisionId` pointer after a new revision is
   * created. The update is **guarded by `revisionNumber`**: it only advances the
   * pointer when the incoming revision is newer than the one currently recorded.
   * This prevents a slower concurrent writer (which allocated an earlier number)
   * from overwriting the pointer with a stale revision. The authoritative "latest"
   * lookup is {@link CodebaseRevisionStore.getLatest} (sorts by `revisionNumber`);
   * this pointer is a denormalized convenience that must not regress.
   */
  async setLatestRevision(
    codebaseId: string,
    revisionId: string,
    revisionNumber: number
  ): Promise<void> {
    await this.collection.updateOne(
      {
        _id: codebaseId,
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

  /**
   * Find a slug not already taken, appending `-2`, `-3`, … as needed.
   * (Soft-deleted codebases still reserve their slug to keep refs stable.)
   */
  private async ensureUniqueSlug(projectId: string, base: string): Promise<string> {
    let candidate = base;
    let n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await this.collection.findOne({ projectId, slug: candidate } as object)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }
}
