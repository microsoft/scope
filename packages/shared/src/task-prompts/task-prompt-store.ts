// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from 'mongodb';
import { randomUUID } from 'crypto';
import { TaskPromptDocument, PromptFeatureResult, PromptType } from '../types/types.js';
import { computePromptId } from './task-prompt-id.js';
import type { BlobStorage } from '../storage/blob-storage.js';

/** Default inline-vs-blob threshold (UTF-8 bytes). Bodies larger than this are
 *  stored in blob storage; smaller bodies stay inline in Mongo. */
export const DEFAULT_PROMPT_INLINE_MAX_BYTES = 16 * 1024;

/** Hard guard cap on prompt body size (UTF-8 bytes). Bodies larger than this
 *  are rejected outright, regardless of storage location. */
export const PROMPT_MAX_BYTES = 256 * 1024;

/** Deterministic blob path for a prompt body that lives in blob storage. */
export function promptBlobName(id: string): string {
  return `prompts/${id}.txt`;
}

/**
 * MongoDB-backed store for task prompt entities.
 *
 * Task prompts are **immutable and per-project**: the content hash
 * (`computePromptId(type, text)`) is stored as `keyId`, and the `_id` is a
 * fresh UUID. The same `(projectId, type, text)` always resolves to the same
 * document — `findOrCreate` is idempotent **within a project**. Two projects
 * that share identical prompt text get **two distinct documents** (same
 * `keyId`, distinct `_id`, distinct `projectId`). Per-project uniqueness is
 * backed by a `{ projectId, keyId }` index — **unique** on real MongoDB, and (on
 * Azure Cosmos DB for MongoDB, which cannot build a unique index on a populated
 * collection) **non-unique**, with uniqueness enforced by `findOrCreate`.
 * `type` defaults to `"select"` so existing task-prompt call sites are
 * unaffected.
 *
 * The body is stored **inline** (`text`) when small, or in **blob storage**
 * (`contentBlobUrl`) when it exceeds the configured inline threshold. Storage
 * location is decided purely by size, independent of the prompt `type`. The
 * blob path is always `prompts/{_id}.txt`.
 *
 * Documents are soft-deleted (deletedAt) rather than removed.
 */
export class TaskPromptStore {
  private readonly inlineMaxBytes: number;

  constructor(
    private collection: Collection<TaskPromptDocument>,
    private blobStorage?: BlobStorage,
    inlineMaxBytes?: number,
  ) {
    this.inlineMaxBytes =
      inlineMaxBytes ??
      (process.env.PROMPT_INLINE_MAX_BYTES
        ? parseInt(process.env.PROMPT_INLINE_MAX_BYTES, 10)
        : DEFAULT_PROMPT_INLINE_MAX_BYTES);
  }

  /** Get a single task prompt by ID (non-deleted). Point reads are global. */
  async get(id: string): Promise<TaskPromptDocument | null> {
    return this.collection.findOne({ _id: id, deletedAt: { $exists: false } });
  }

  /** Get a task prompt by its text content and type within a project (non-deleted) */
  async getByText(
    projectId: string,
    text: string,
    type: PromptType = 'select',
  ): Promise<TaskPromptDocument | null> {
    const keyId = computePromptId(type, text.trim());
    return this.collection.findOne({
      projectId,
      keyId,
      deletedAt: { $exists: false },
    });
  }

  /**
   * Resolve a prompt document's body to plain text, regardless of storage
   * location: returns inline `text` when present, otherwise downloads the body
   * from blob storage. Throws if the document has neither (corrupt) or if blob
   * storage is needed but not configured.
   */
  async resolvePromptText(doc: TaskPromptDocument): Promise<string> {
    if (doc.text != null) return doc.text;
    if (doc.contentBlobUrl) {
      if (!this.blobStorage) {
        throw new Error(
          `Task prompt '${doc._id}' body is in blob storage but no BlobStorage is configured`,
        );
      }
      const buf = await this.blobStorage.downloadBlobToBuffer(promptBlobName(doc._id));
      return buf.toString('utf-8');
    }
    throw new Error(`Task prompt '${doc._id}' has neither inline text nor a blob reference`);
  }

  /**
   * Find an existing task prompt by `(projectId, type, text)`, or create a new
   * one. Idempotent **within a project** — the same `(projectId, type, text)`
   * always returns the same document. `type` defaults to `"select"` (the
   * request task prompt). Distinct projects get distinct documents even for
   * identical text.
   *
   * Bodies over the inline threshold are uploaded to blob storage on a create
   * **miss** (and the doc stores only a `contentBlobUrl`); smaller bodies are
   * stored inline. The dedup/lookup is by `{ projectId, keyId }` and never
   * touches blob.
   *
   * @param name - Optional human-readable label. Set on a new prompt; on an
   *   existing match it only fills in a missing name and never overwrites one
   *   (use {@link rename} to change it).
   */
  async findOrCreate(
    projectId: string,
    text: string,
    type: PromptType = 'select',
    name?: string,
  ): Promise<TaskPromptDocument> {
    const trimmed = text.trim();
    const keyId = computePromptId(type, trimmed);

    // Try to find existing within this project (including soft-deleted — revive if needed)
    const existing = await this.collection.findOne({ projectId, keyId });
    if (existing) {
      // Backfill type on legacy documents lacking it, and revive if soft-deleted.
      const patch: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};
      if (existing.type === undefined) patch.type = type;
      if (name && !existing.name) patch.name = name;
      if (existing.deletedAt) unset.deletedAt = '';
      if (Object.keys(patch).length > 0 || Object.keys(unset).length > 0) {
        await this.collection.updateOne(
          { _id: existing._id },
          {
            ...(Object.keys(patch).length > 0 ? { $set: patch } : {}),
            ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
          } as any,
        );
        return { ...existing, ...patch, deletedAt: undefined };
      }
      return existing;
    }

    // Enforce the hard size cap before storing anywhere.
    const byteLength = Buffer.byteLength(trimmed, 'utf-8');
    if (byteLength > PROMPT_MAX_BYTES) {
      throw new Error(
        `Prompt body is ${byteLength} bytes, exceeding the maximum of ${PROMPT_MAX_BYTES} bytes`,
      );
    }

    const id = randomUUID();
    const doc: TaskPromptDocument = {
      _id: id,
      projectId,
      keyId,
      type,
      ...(name ? { name } : {}),
      createdAt: new Date(),
    };

    // Size-based storage: large bodies go to blob, small bodies stay inline.
    if (byteLength > this.inlineMaxBytes) {
      if (!this.blobStorage) {
        throw new Error(
          `Prompt body is ${byteLength} bytes (over the ${this.inlineMaxBytes}-byte inline ` +
            `threshold) but no BlobStorage is configured to store it`,
        );
      }
      doc.contentBlobUrl = await this.blobStorage.uploadText(
        promptBlobName(id),
        trimmed,
      );
    } else {
      doc.text = trimmed;
    }

    await this.collection.insertOne(doc as any);
    return doc;
  }

  /**
   * List active (non-deleted) task prompts.
   * Supports pagination, optional case-insensitive search on name or text, and an optional
   * `type` filter. Pass a `type` (e.g. `'select'` or `'agents.md'`) to scope the
   * list to a single type. With no `type`, all prompt types are returned — gate
   * prompts, non-gate types such as `agents.md`, and legacy untyped docs.
   */
  async getAll(opts?: {
    projectId?: string;
    limit?: number;
    offset?: number;
    search?: string;
    type?: PromptType;
  }): Promise<{ items: TaskPromptDocument[]; total: number }> {
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };

    if (opts?.projectId) {
      filter.projectId = opts.projectId;
    }
    if (opts?.search) {
      const pattern = { $regex: opts.search, $options: 'i' };
      filter.$or = [{ name: pattern }, { text: pattern }];
    }
    if (opts?.type) {
      filter.type = opts.type;
    }

    const total = await this.collection.countDocuments(filter);
    const cursor = this.collection
      .find(filter)
      .sort({ createdAt: -1 });

    if (opts?.offset) {
      cursor.skip(opts.offset);
    }
    if (opts?.limit) {
      cursor.limit(opts.limit);
    }

    const items = await cursor.toArray();
    return { items, total };
  }

  /**
   * Set or clear a task prompt's human-readable name. The name is a label
   * only, so this never changes the prompt's identity (`_id` / `keyId`).
   *
   * @param name - New name, or `null` to remove it.
   * @throws Error when the prompt does not exist or is soft-deleted.
   */
  async rename(id: string, name: string | null): Promise<TaskPromptDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task prompt '${id}' not found`);
    }

    await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      name === null ? { $unset: { name: '' } } : { $set: { name } },
    );

    return (await this.get(id))!;
  }

  /** Soft-delete a task prompt */
  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task prompt '${id}' not found`);
    }

    await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );
  }

  /**
   * Attach prompt feature extraction results to a task prompt.
   * This is the only mutable operation — it enriches the entity
   * without changing its identity (text / _id).
   */
  async attachFeatures(
    id: string,
    features: PromptFeatureResult[]
  ): Promise<TaskPromptDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task prompt '${id}' not found`);
    }

    await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      {
        $set: {
          features,
          featuresExtractedAt: new Date(),
        },
      }
    );

    return (await this.get(id))!;
  }

  /**
   * Toggle the `detected` flag on a single feature.
   * If the feature doesn't exist in the array, it's added as evaluated+detected.
   */
  async toggleFeature(
    id: string,
    featureId: string,
    detected: boolean
  ): Promise<TaskPromptDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task prompt '${id}' not found`);
    }

    const features = existing.features ? [...existing.features] : [];
    const idx = features.findIndex((f) => f.featureId === featureId);

    if (idx >= 0) {
      features[idx] = { ...features[idx], detected, evaluated: true };
    } else {
      features.push({ featureId, detected, evaluated: true });
    }

    await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { features } }
    );

    return (await this.get(id))!;
  }
}
