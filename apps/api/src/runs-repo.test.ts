// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import {
  insertHistoricalRun,
  listHistoricalRuns,
  getHistoricalRun,
} from "./runs-repo.js";
import type { RunState } from "@scope/core";

function makeRunsCol(initial: any[] = []) {
  const docs = [...initial];
  return {
    docs,
    insertOne: vi.fn(async (d: any) => {
      docs.push(d);
      return { insertedId: d._id };
    }),
    findOne: vi.fn(async (filter: any) => docs.find((d) => d._id === filter._id) ?? null),
    find: vi.fn((filter: any) => ({
      sort: () => ({
        toArray: async () =>
          docs
            .filter((d) => d.requestId === filter.requestId)
            .sort((a, b) => b.attemptNumber - a.attemptNumber),
      }),
    })),
  };
}

describe("runs-repo", () => {
  it("inserts a historical run with requestId back-reference", async () => {
    const col = makeRunsCol();
    const run: RunState = {
      _id: "run-1",
      attemptNumber: 1,
      status: "done",
      outcome: "failed",
    };
    await insertHistoricalRun({ runsCollection: col as any }, "req-1", run);

    expect(col.insertOne).toHaveBeenCalledTimes(1);
    expect(col.docs[0]).toEqual({
      _id: "run-1",
      attemptNumber: 1,
      status: "done",
      outcome: "failed",
      requestId: "req-1",
    });
  });

  it("lists historical runs newest first by attemptNumber", async () => {
    const col = makeRunsCol([
      { _id: "r1", attemptNumber: 1, status: "done", requestId: "req-1" },
      { _id: "r2", attemptNumber: 2, status: "done", requestId: "req-1" },
      { _id: "r3", attemptNumber: 1, status: "done", requestId: "req-other" },
    ]);
    const result = await listHistoricalRuns({ runsCollection: col as any }, "req-1");
    expect(result.map((r) => r._id)).toEqual(["r2", "r1"]);
  });

  it("fetches a single historical run by id", async () => {
    const col = makeRunsCol([
      { _id: "r1", attemptNumber: 1, status: "done", requestId: "req-1" },
    ]);
    const result = await getHistoricalRun({ runsCollection: col as any }, "r1");
    expect(result?._id).toBe("r1");
  });

  it("returns null when run id not found in history", async () => {
    const col = makeRunsCol();
    const result = await getHistoricalRun({ runsCollection: col as any }, "missing");
    expect(result).toBeNull();
  });
});
