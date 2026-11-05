// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import { AddExperimentIdIndex } from "./migrations/031-add-experiment-id-index.js";

function makeMockDb(createIndexImpl?: () => Promise<string>) {
  const createIndex = vi.fn(createIndexImpl ?? (async () => "experimentId_1"));
  const requests = { createIndex };
  const db = {
    collection: vi.fn((name: string) => {
      if (name === "requests") return requests;
      throw new Error(`Unexpected collection ${name}`);
    }),
  } as unknown as Db;
  return { db, createIndex };
}

describe("migration 031: AddExperimentIdIndex", () => {
  it("creates a sparse single-field index on requests.experimentId", async () => {
    const { db, createIndex } = makeMockDb();

    await new AddExperimentIdIndex().up(db);

    expect(createIndex).toHaveBeenCalledWith(
      { experimentId: 1 },
      { sparse: true },
    );
  });

  it("treats an existing index as idempotent", async () => {
    const { db } = makeMockDb(async () => {
      throw new Error("index already exists");
    });

    await expect(new AddExperimentIdIndex().up(db)).resolves.toBeUndefined();
  });

  it("does not drop the index on down", async () => {
    const { db, createIndex } = makeMockDb();

    await expect(new AddExperimentIdIndex().down(db)).resolves.toBeUndefined();
    expect(createIndex).not.toHaveBeenCalled();
  });
});
