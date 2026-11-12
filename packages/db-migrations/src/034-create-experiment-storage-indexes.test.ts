// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { CreateExperimentStorageIndexes } from "./migrations/034-create-experiment-storage-indexes.js";

function collection() {
  return { createIndex: vi.fn(async () => "index") };
}

describe("migration 034: experiment storage indexes", () => {
  it("creates only project paging and execution history indexes", async () => {
    const experiments = collection();
    const executions = collection();
    const chunks = collection();
    const db = {
      collection: vi.fn((name: string) => {
        if (name === "experiments") return experiments;
        if (name === "experiment-executions") return executions;
        if (name === "experiment-chunks") return chunks;
        throw new Error(`Unexpected collection ${name}`);
      }),
    } as unknown as Db;

    await new CreateExperimentStorageIndexes().up(db);

    expect(experiments.createIndex).toHaveBeenCalledWith(
      { projectId: 1, _id: 1 },
      {},
    );
    expect(executions.createIndex).toHaveBeenCalledWith(
      { projectId: 1 },
      {},
    );
    expect(executions.createIndex).toHaveBeenCalledWith(
      { experimentId: 1, attemptNumber: -1 },
      {},
    );
    expect(chunks.createIndex).not.toHaveBeenCalled();
  });
});
