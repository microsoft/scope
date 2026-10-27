// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- Project types ---

/**
 * Project reference document stored in MongoDB (`projects` collection).
 *
 * A **first-class container** for organizing user-facing data. Every scoped
 * entity (runs, profiles, criteria, codebases, reports, insights, skills,
 * extensions, task-prompts, prompt-features, report-templates, mcp-servers…)
 * carries an immutable `projectId` pointing at one of these.
 *
 * There is **no "default" project** and no `isDefault` flag: a project is an
 * ordinary, re-nameable record. The data migration seeds one initial project
 * and files all pre-existing entities into it, but that project is not treated
 * specially thereafter — a scoped operation that cannot resolve its project is
 * an error, never silently bucketed into a fallback.
 *
 * The `_id` is a fresh UUID.
 */
export interface ProjectDocument {
  _id: string;          // Fresh UUID
  name: string;         // Human-readable display name (re-nameable)
  description?: string;
  creator?: string;     // Who created it (provenance)
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;     // Soft-delete timestamp
  revision?: number;
  lastOperationId?: string;
  appliedOperationIds?: string[];
}
