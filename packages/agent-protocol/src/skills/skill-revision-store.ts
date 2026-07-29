// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from 'mongodb';
import type { SkillRevisionDocument } from '@scope/core';
import { computeSkillRevisionId } from './skill-revision-id.js';

/**
 * MongoDB-backed store for skill revision entities.
 *
 * Skill revisions are **immutable and content-addressed**: the `_id` is a UUIDv5
 * derived from the ref string (`{source}/{skillName}@{commitHash}`).
 * The same source + skill + commit always resolves to the same document.
 *
 * `findOrCreate` is idempotent — calling it multiple times with the same
 * ref will return the same document without duplication.
 */
export class SkillRevisionStore {
  constructor(private collection: Collection<SkillRevisionDocument>) {}

  /** Get a single skill revision by ID (UUIDv5) */
  async get(id: string): Promise<SkillRevisionDocument | null> {
    return this.collection.findOne({ _id: id });
  }

  /** Get a skill revision by its human-readable ref string */
  async getByRef(ref: string): Promise<SkillRevisionDocument | null> {
    return this.get(computeSkillRevisionId(ref));
  }

  /**
   * Find an existing skill revision by ref, or create a new one.
   * Idempotent — same ref always returns the same document.
   *
   * @param doc - The full skill revision document to insert (if not already present).
   *              The `_id` field will be computed from `doc.ref`.
   * @returns The existing or newly created document.
   */
  async findOrCreate(
    doc: Omit<SkillRevisionDocument, '_id' | 'createdAt'>
  ): Promise<SkillRevisionDocument> {
    const id = computeSkillRevisionId(doc.ref);

    // Try to find existing
    const existing = await this.collection.findOne({ _id: id });
    if (existing) {
      return existing;
    }

    // Create new document
    const fullDoc: SkillRevisionDocument = {
      ...doc,
      _id: id,
      createdAt: new Date(),
    };

    await this.collection.insertOne(fullDoc as any);
    return fullDoc;
  }

  /**
   * List skill revisions for a given source + skillName, ordered by resolvedAt descending.
   * Useful for seeing the revision history of a particular skill.
   */
  async listBySkill(
    source: string,
    skillName: string,
    opts?: { limit?: number }
  ): Promise<SkillRevisionDocument[]> {
    return this.collection
      .find({ source, skillName })
      .sort({ resolvedAt: -1 })
      .limit(opts?.limit ?? 20)
      .toArray();
  }

  /**
   * Resolve multiple refs in bulk, returning documents for each.
   * Used by the queue processor to resolve RequestDocument.skillRevisions.
   */
  async getByRefs(refs: string[]): Promise<SkillRevisionDocument[]> {
    if (refs.length === 0) return [];

    const ids = refs.map(computeSkillRevisionId);
    return this.collection.find({ _id: { $in: ids } }).toArray();
  }

  /**
   * Delete all revisions for a given source + skillName.
   * Used when a skill is deleted to clean up associated revision data.
   *
   * @returns The number of deleted revision documents.
   */
  async deleteBySkill(source: string, skillName: string): Promise<number> {
    const result = await this.collection.deleteMany({ source, skillName });
    return result.deletedCount;
  }
}
