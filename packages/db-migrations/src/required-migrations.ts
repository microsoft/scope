// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Canonical list of required migrations.
 *
 * The API readiness probe queries the `_migrations` collection and checks
 * that every file listed here has been applied. If any are missing the pod
 * reports "not ready" and Kubernetes will hold traffic until the migration
 * Job completes.
 *
 * **Maintenance**: add an entry here whenever you create a new migration file.
 */

export const REQUIRED_MIGRATIONS: readonly string[] = [
  "001-backfill-task-prompts.ts",
  "002-create-indexes.ts",
  "003-create-skill-indexes.ts",
  "004-add-submission-id-index.ts",
  "005-backfill-iteration-durations.ts",
  "006-split-status-outcome.ts",
  "007-rename-exhausted-to-finished.ts",
  "008-backfill-ai-call-count.ts",
  "009-add-requests-filter-indexes.ts",
  "010-add-requests-pagination-index.ts",
  "011-add-profile-indexes.ts",
  "012-add-profile-name-index.ts",
  "013-remove-logs-from-docs.ts",
  "014-introduce-runs-and-run.ts",
  "015-add-priority-and-scheduler-index.ts",
  "016-fix-scheduler-sort-index.ts",
  "017-add-post-processor-dispatch-index.ts",
  "018-backfill-criteria-gates.ts",
  "019-backfill-task-prompt-type.ts",
  "020-create-codebase-indexes.ts",
  "021-add-runs-filter-indexes.ts",
  "022-add-runs-sort-indexes.ts",
  "023-add-runs-search-task-index.ts",
  "024-add-criteria-sort-index.ts",
  "025-create-projects.ts",
  "026-isolate-catalogs-per-project.ts",
  "027-uuid-keys-mcp-profileversions.ts",
  "028-isolate-mcp-secrets-per-project.ts",
  "029-create-users-collection.ts",
];
