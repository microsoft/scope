// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { AddExperimentLifecycleIndexes } from "./migrations/036-add-experiment-lifecycle-indexes.js";

function collection() {
  return { createIndex: vi.fn(async () => "index") };
}

describe("migration 036: experiment lifecycle indexes", () => {
  it("creates the lifecycle repair and provenance indexes", async () => {
    const experiments = collection();
    const requests = collection();
    const reports = collection();
    const db = {
      collection: vi.fn((name: string) => {
        if (name === "experiments") return experiments;
        if (name === "requests") return requests;
        if (name === "reports") return reports;
        throw new Error(`Unexpected collection ${name}`);
      }),
    } as unknown as Db;

    await new AddExperimentLifecycleIndexes().up(db);

    expect(experiments.createIndex).toHaveBeenCalledWith(
      { "lifecycle.phase": 1, updatedAt: 1 },
      {},
    );
    expect(requests.createIndex).toHaveBeenCalledWith(
      { "deletionProvenance.operationId": 1 },
      {},
    );
    expect(reports.createIndex).toHaveBeenCalledWith(
      { experimentId: 1 },
      {},
    );
    expect(reports.createIndex).toHaveBeenCalledWith(
      { "deletionProvenance.operationId": 1 },
      {},
    );
  });
});
