// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { CreateRunShareIndexes } from "./migrations/031-create-run-share-indexes.js";

function setup(missing = false) {
  const createIndex = vi.fn(async (_key: Record<string, 1 | -1>, _options?: { unique?: boolean }) => "created");
  const indexes = vi.fn(async () => missing ? [] : [
    { key: { _id: 1 } }, { key: { requestId: 1 } }, { key: { runId: 1 } },
    { key: { projectId: 1 } }, { key: { createdBy: 1 } },
  ]);
  const db = { collection: vi.fn(() => ({ createIndex, indexes })) } as unknown as Db;
  return { db, createIndex, indexes };
}

describe("run-share migration", () => {
  it("creates single-field indexes and verifies them on both collections", async () => {
    const { db, createIndex, indexes } = setup();
    await new CreateRunShareIndexes().up(db);
    expect(createIndex).toHaveBeenCalledTimes(5);
    expect(indexes).toHaveBeenCalledTimes(2);
    for (const call of createIndex.mock.calls) expect(Object.keys(call[0])).toHaveLength(1);
  });

  it("fails when Cosmos silently omits an index", async () => {
    const { db } = setup(true);
    await expect(new CreateRunShareIndexes().up(db)).rejects.toThrow(/Missing .* index/);
  });

  it("does not delete published links on rollback", async () => {
    const { db, createIndex } = setup();
    await new CreateRunShareIndexes().down(db);
    expect(db.collection).not.toHaveBeenCalled();
    expect(createIndex).not.toHaveBeenCalled();
  });
});
