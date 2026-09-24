// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkMigrations,
  resetMigrationCheckCache,
  type MigrationCheckResult,
} from "./check-migrations.js";

// Mock Db
function makeMockDb(appliedFiles: string[]) {
  const docs = appliedFiles.map((file) => ({
    file,
    className: file.replace(".ts", ""),
    timestamp: Date.now(),
  }));
  return {
    collection: vi.fn().mockReturnValue({
      find: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(docs),
      }),
    }),
  } as any;
}

describe("checkMigrations", () => {
  beforeEach(() => {
    resetMigrationCheckCache();
  });

  it("returns ready when all required migrations are applied", async () => {
    const db = makeMockDb([
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
    ]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.totalApplied).toBe(29);
    expect(result.applied).toEqual([
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
    ]);
  });

  it("returns not ready when migrations are missing", async () => {
    const db = makeMockDb(["001-backfill-task-prompts.ts"]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(false);
    expect(result.pending).toEqual(["002-create-indexes.ts", "003-create-skill-indexes.ts", "004-add-submission-id-index.ts", "005-backfill-iteration-durations.ts", "006-split-status-outcome.ts", "007-rename-exhausted-to-finished.ts", "008-backfill-ai-call-count.ts", "009-add-requests-filter-indexes.ts", "010-add-requests-pagination-index.ts", "011-add-profile-indexes.ts", "012-add-profile-name-index.ts", "013-remove-logs-from-docs.ts", "014-introduce-runs-and-run.ts", "015-add-priority-and-scheduler-index.ts", "016-fix-scheduler-sort-index.ts", "017-add-post-processor-dispatch-index.ts", "018-backfill-criteria-gates.ts", "019-backfill-task-prompt-type.ts", "020-create-codebase-indexes.ts", "021-add-runs-filter-indexes.ts", "022-add-runs-sort-indexes.ts", "023-add-runs-search-task-index.ts", "024-add-criteria-sort-index.ts", "025-create-projects.ts", "026-isolate-catalogs-per-project.ts", "027-uuid-keys-mcp-profileversions.ts", "028-isolate-mcp-secrets-per-project.ts", "029-create-users-collection.ts"]);
    expect(result.applied).toEqual(["001-backfill-task-prompts.ts"]);
    expect(result.totalApplied).toBe(1);
  });

  it("returns not ready when no migrations are applied", async () => {
    const db = makeMockDb([]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(false);
    expect(result.pending).toEqual([
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
    ]);
    expect(result.applied).toEqual([]);
    expect(result.totalApplied).toBe(0);
  });

  it("ignores extra applied migrations not in the required list", async () => {
    const db = makeMockDb([
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
      "999-future-migration.ts",
    ]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.totalApplied).toBe(30);
  });

  it("caches results within TTL", async () => {
    const db = makeMockDb([
      "001-backfill-task-prompts.ts",
      "002-create-indexes.ts",
      "003-create-skill-indexes.ts",
      "004-add-submission-id-index.ts",
    ]);
    const result1 = await checkMigrations(db);
    const result2 = await checkMigrations(db);

    expect(result1).toBe(result2); // same reference = cached
    // find() should only have been called once
    expect(db.collection).toHaveBeenCalledTimes(1);
  });

  it("queries _migrations collection", async () => {
    const db = makeMockDb([]);
    await checkMigrations(db);
    expect(db.collection).toHaveBeenCalledWith("_migrations");
  });
});
