// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkMigrations,
  resetMigrationCheckCache,
  type MigrationCheckResult,
} from "./check-migrations.js";
import { REQUIRED_MIGRATIONS } from "./required-migrations.js";

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
    const db = makeMockDb([...REQUIRED_MIGRATIONS]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.totalApplied).toBe(REQUIRED_MIGRATIONS.length);
    expect(result.applied).toEqual(REQUIRED_MIGRATIONS);
  });

  it("returns not ready when migrations are missing", async () => {
    const db = makeMockDb(["001-backfill-task-prompts.ts"]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(false);
    expect(result.pending).toEqual(REQUIRED_MIGRATIONS.slice(1));
    expect(result.applied).toEqual(["001-backfill-task-prompts.ts"]);
    expect(result.totalApplied).toBe(1);
  });

  it("returns not ready when no migrations are applied", async () => {
    const db = makeMockDb([]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(false);
    expect(result.pending).toEqual(REQUIRED_MIGRATIONS);
    expect(result.applied).toEqual([]);
    expect(result.totalApplied).toBe(0);
  });

  it("ignores extra applied migrations not in the required list", async () => {
    const db = makeMockDb([
      ...REQUIRED_MIGRATIONS,
      "999-future-migration.ts",
    ]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.totalApplied).toBe(REQUIRED_MIGRATIONS.length + 1);
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
