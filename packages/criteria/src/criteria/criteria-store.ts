// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from 'mongodb';
import type { CriteriaConfig, CriteriaDocument } from '@scope/core';
import { DependencyGraph } from '../graph/dependency-graph.js';

/**
 * MongoDB-backed criteria store for CRUD operations on criteria definitions.
 *
 * Replaces filesystem-based criteria loading for multi-instance deployments.
 * Criteria documents are soft-deleted (deletedAt) rather than removed.
 */
export class CriteriaStore {
  constructor(private collection: Collection<CriteriaDocument>) {}

  /** List all active (non-deleted) criteria */
  async getAll(): Promise<CriteriaDocument[]> {
    return this.collection
      .find({ deletedAt: { $exists: false } })
      .sort({ id: 1 })
      .toArray();
  }

  /** Get a single criterion by ID */
  async get(id: string): Promise<CriteriaDocument | null> {
    return this.collection.findOne({ id, deletedAt: { $exists: false } });
  }

  /** Create a new criterion. Validates uniqueness and dependency references. */
  async create(input: {
    id: string;
    prompt: string;
    dependsOn?: string[];
  }): Promise<CriteriaDocument> {
    const { id, prompt, dependsOn = [] } = input;

    // Validate ID format
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error(
        `Invalid criteria ID '${id}'. Must match [a-z0-9_-]+`
      );
    }

    // Check for duplicates
    const existing = await this.collection.findOne({ id, deletedAt: { $exists: false } });
    if (existing) {
      throw new Error(`Criteria '${id}' already exists`);
    }

    // Validate dependency references exist
    if (dependsOn.length > 0) {
      await this.validateDependencies(dependsOn);
    }

    // Validate no cycles would be introduced
    if (dependsOn.length > 0) {
      await this.validateNoCycles(id, dependsOn);
    }

    const doc: CriteriaDocument = {
      id,
      prompt: prompt.trim(),
      dependsOn,
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc as any);
    return doc;
  }

  /** Update a criterion's prompt and/or dependencies */
  async update(
    id: string,
    patch: { prompt?: string; dependsOn?: string[] }
  ): Promise<CriteriaDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Criteria '${id}' not found`);
    }

    // Validate dependencies if changing them
    if (patch.dependsOn !== undefined) {
      if (patch.dependsOn.length > 0) {
        await this.validateDependencies(patch.dependsOn);
      }
      await this.validateNoCycles(id, patch.dependsOn);
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.prompt !== undefined) update.prompt = patch.prompt.trim();
    if (patch.dependsOn !== undefined) update.dependsOn = patch.dependsOn;

    await this.collection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: update }
    );

    return (await this.get(id))!;
  }

  /**
   * Soft-delete a criterion.
   * Rejects if other active criteria depend on this one.
   */
  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Criteria '${id}' not found`);
    }

    // Check for dependents
    const dependents = await this.collection
      .find({
        dependsOn: id,
        deletedAt: { $exists: false },
      })
      .toArray();

    if (dependents.length > 0) {
      const depIds = dependents.map((d) => d.id).join(', ');
      throw new Error(
        `Cannot delete '${id}': other criteria depend on it: ${depIds}`
      );
    }

    await this.collection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );
  }

  /**
   * Resolve criteria IDs to CriteriaConfig objects, including all transitive ancestors.
   * Same BFS logic as FileSystemCriteriaProvider.resolveWithAncestors but reads from MongoDB.
   */
  async resolveWithAncestors(ids: string[]): Promise<CriteriaConfig[]> {
    const collected = new Map<string, CriteriaConfig>();
    const queue = [...ids];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (collected.has(id)) continue;

      const doc = await this.get(id);
      if (!doc) {
        const all = await this.getAll();
        const availableIds = all.map((c) => c.id).join(', ');
        throw new Error(
          `Criteria '${id}' not found in store. Available: ${availableIds || 'none'}`
        );
      }

      collected.set(id, { id: doc.id, prompt: doc.prompt, dependsOn: doc.dependsOn });

      if (doc.dependsOn) {
        for (const parentId of doc.dependsOn) {
          if (!collected.has(parentId)) {
            queue.push(parentId);
          }
        }
      }
    }

    return Array.from(collected.values());
  }

  /**
   * Get the full DAG as nodes + edges for visualization.
   */
  async getGraph(): Promise<{
    nodes: CriteriaConfig[];
    edges: { from: string; to: string }[];
  }> {
    const all = await this.getAll();
    const nodes: CriteriaConfig[] = all.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      dependsOn: c.dependsOn,
    }));

    const edges: { from: string; to: string }[] = [];
    for (const criterion of all) {
      if (criterion.dependsOn) {
        for (const parentId of criterion.dependsOn) {
          edges.push({ from: parentId, to: criterion.id });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Seed criteria from YAML-loaded configs (upsert — skip existing).
   * Returns the number of newly inserted criteria.
   */
  async seed(configs: CriteriaConfig[]): Promise<number> {
    let inserted = 0;
    for (const config of configs) {
      const existing = await this.collection.findOne({ id: config.id });
      if (!existing) {
        await this.collection.insertOne({
          id: config.id,
          prompt: config.prompt,
          dependsOn: config.dependsOn || [],
          createdAt: new Date(),
        } as any);
        inserted++;
      }
    }
    return inserted;
  }

  // --- Private helpers ---

  /** Validate that all referenced dependency IDs exist in the store */
  private async validateDependencies(dependsOn: string[]): Promise<void> {
    for (const depId of dependsOn) {
      const dep = await this.get(depId);
      if (!dep) {
        throw new Error(`Dependency '${depId}' does not exist`);
      }
    }
  }

  /** Validate that adding edges would not introduce a cycle */
  private async validateNoCycles(
    criterionId: string,
    dependsOn: string[]
  ): Promise<void> {
    // Build a temporary in-memory graph with the proposed change
    const all = await this.getAll();
    const configs: CriteriaConfig[] = all.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      dependsOn: c.id === criterionId ? dependsOn : c.dependsOn,
    }));

    // If this is a new criterion, add it
    if (!configs.some((c) => c.id === criterionId)) {
      configs.push({ id: criterionId, prompt: '(pending)', dependsOn });
    }

    try {
      new DependencyGraph(configs);
    } catch (error) {
      if (error instanceof Error && error.message.includes('ycle')) {
        throw new Error(
          `Adding dependencies [${dependsOn.join(', ')}] to '${criterionId}' would create a cycle`
        );
      }
      throw error;
    }
  }
}
