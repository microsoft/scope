// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from 'mongodb';
import type { ReportTemplateDocument } from '@scope/core';

/**
 * MongoDB-backed store for report template CRUD operations.
 *
 * Report templates define what reports to generate (userPrompt, systemPrompt)
 * and when to generate them (trigger). Templates are identified by a
 * human-readable slug (`id`) and soft-deleted via `deletedAt`.
 */
export class ReportTemplateStore {
  constructor(private collection: Collection<ReportTemplateDocument>) {}

  /** List all active (non-deleted) report templates */
  async getAll(): Promise<ReportTemplateDocument[]> {
    return this.collection
      .find({ deletedAt: { $exists: false } })
      .sort({ id: 1 })
      .toArray();
  }

  /** Get a single report template by slug ID */
  async get(id: string): Promise<ReportTemplateDocument | null> {
    return this.collection.findOne({ id, deletedAt: { $exists: false } });
  }

  /** Create a new report template. Validates uniqueness and required fields. */
  async create(input: {
    id: string;
    name: string;
    description?: string;
    userPrompt: string;
    systemPrompt?: { mode: 'append' | 'override'; content: string };
    trigger?: ReportTemplateDocument['trigger'];
  }): Promise<ReportTemplateDocument> {
    const { id, name, userPrompt, description, systemPrompt, trigger } = input;

    // Validate ID format
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
      throw new Error(
        `Invalid report template ID '${id}'. Must start with a letter and match [a-z][a-z0-9_-]*`
      );
    }

    // Check for duplicates
    const existing = await this.collection.findOne({ id, deletedAt: { $exists: false } });
    if (existing) {
      throw new Error(`Report template '${id}' already exists`);
    }

    // Validate required fields
    if (!name || !name.trim()) {
      throw new Error('Report template name is required');
    }
    if (!userPrompt || !userPrompt.trim()) {
      throw new Error('Report template userPrompt is required');
    }

    const doc: ReportTemplateDocument = {
      _id: crypto.randomUUID(),
      id,
      name: name.trim(),
      ...(description ? { description: description.trim() } : {}),
      userPrompt: userPrompt.trim(),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(trigger ? { trigger } : {}),
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc as any);
    return doc;
  }

  /** Update a report template's fields */
  async update(
    id: string,
    patch: {
      name?: string;
      description?: string;
      userPrompt?: string;
      systemPrompt?: { mode: 'append' | 'override'; content: string } | null;
      trigger?: ReportTemplateDocument['trigger'] | null;
    }
  ): Promise<ReportTemplateDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Report template '${id}' not found`);
    }

    const $set: Record<string, unknown> = { updatedAt: new Date() };
    const $unset: Record<string, unknown> = {};

    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error('Report template name cannot be empty');
      $set.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      $set.description = patch.description.trim();
    }
    if (patch.userPrompt !== undefined) {
      if (!patch.userPrompt.trim()) throw new Error('Report template userPrompt cannot be empty');
      $set.userPrompt = patch.userPrompt.trim();
    }

    // null = remove the field, object = set it
    if (patch.systemPrompt === null) {
      $unset.systemPrompt = '';
    } else if (patch.systemPrompt !== undefined) {
      $set.systemPrompt = patch.systemPrompt;
    }

    if (patch.trigger === null) {
      $unset.trigger = '';
    } else if (patch.trigger !== undefined) {
      $set.trigger = patch.trigger;
    }

    const updateOp: Record<string, unknown> = { $set };
    if (Object.keys($unset).length > 0) {
      updateOp.$unset = $unset;
    }

    await this.collection.updateOne(
      { id, deletedAt: { $exists: false } },
      updateOp as any
    );

    return (await this.get(id))!;
  }

  /** Soft-delete a report template */
  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Report template '${id}' not found`);
    }

    await this.collection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );
  }
}
