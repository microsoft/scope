// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
  TaxonomyExpectationStore,
  type ExperimentRunPair,
} from "./taxonomy-expectation-store.js";
import type {
  ExperimentDocument,
  ExperimentExecutionHistoryDocument,
} from "./types.js";

function collection(rows: Document[]) {
  const toArray = vi.fn().mockResolvedValue(rows);
  const find = vi.fn(() => ({ toArray }));
  return {
    collection: { find } as unknown as Collection<Document>,
    find,
  };
}

function pair(
  experimentId: string,
  requestId: string,
  runId: string,
): ExperimentRunPair {
  return { experimentId, requestId, runId };
}

describe("TaxonomyExpectationStore", () => {
  it("resolves exact current and historical inline/chunked pairs with three bulk reads", async () => {
    const roots = collection([
      {
        _id: "experiment-current",
        execution: {
          experimentExecutionId: "execution-current",
          taxonomy: { taxonomyRevisionId: "taxonomy-1" },
          requests: {
            storage: "inline",
            entries: [
              { requestId: "request-1", runId: "run-1" },
              { requestId: "unrelated", runId: "unrelated-run" },
            ],
          },
        },
      },
      {
        _id: "experiment-current-chunk",
        execution: {
          experimentExecutionId: "execution-current-chunk",
          taxonomy: { taxonomyRevisionId: "taxonomy-1" },
          requests: { storage: "chunked" },
        },
      },
      {
        _id: "experiment-history",
        execution: {
          experimentExecutionId: "execution-newer",
          requests: { storage: "inline", entries: [] },
        },
      },
      {
        _id: "experiment-history-chunk",
        execution: {
          experimentExecutionId: "execution-newer-chunk",
          requests: { storage: "chunked" },
        },
      },
    ]);
    const chunks = collection([
      {
        experimentId: "experiment-current-chunk",
        ownerId: "execution-current-chunk",
        entries: [{ state: { requestId: "request-2", runId: "run-2" } }],
      },
      {
        experimentId: "experiment-history-chunk",
        ownerId: "execution-history-chunk",
        entries: [{ state: { requestId: "request-4", runId: "run-4" } }],
      },
    ]);
    const histories = collection([
      {
        _id: "execution-history",
        experimentId: "experiment-history",
        experimentExecutionId: "execution-history",
        taxonomy: { taxonomyRevisionId: "taxonomy-1" },
        requests: {
          storage: "inline",
          entries: [{ requestId: "request-3", runId: "run-3" }],
        },
      },
      {
        _id: "execution-history-chunk",
        experimentId: "experiment-history-chunk",
        experimentExecutionId: "execution-history-chunk",
        taxonomy: { taxonomyRevisionId: "taxonomy-1" },
        requests: { storage: "chunked" },
      },
    ]);
    const store = new TaxonomyExpectationStore({
      experiments: roots.collection as unknown as Collection<ExperimentDocument>,
      executions: histories.collection as unknown as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunks.collection,
    });
    const pairs = [
      pair("experiment-current", "request-1", "run-1"),
      pair("experiment-current-chunk", "request-2", "run-2"),
      pair("experiment-history", "request-3", "run-3"),
      pair("experiment-history-chunk", "request-4", "run-4"),
      pair("experiment-current", "request-5", "run-5"),
    ];

    const expected = await store.findExpectedPairs("project-1", pairs);

    expect(expected).toEqual(new Set(pairs.slice(0, 4).map(
      TaxonomyExpectationStore.key,
    )));
    expect(roots.find).toHaveBeenCalledTimes(1);
    expect(chunks.find).toHaveBeenCalledTimes(1);
    expect(histories.find).toHaveBeenCalledTimes(1);
    expect(chunks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        experimentId: { $in: expect.arrayContaining([
          "experiment-current",
          "experiment-history",
        ]) },
        "entries.state.requestId": { $in: expect.arrayContaining([
          "request-1",
          "request-5",
        ]) },
      }),
      expect.any(Object),
    );
  });

  it("performs no collection reads for an empty page", async () => {
    const roots = collection([]);
    const chunks = collection([]);
    const histories = collection([]);
    const store = new TaxonomyExpectationStore({
      experiments: roots.collection as unknown as Collection<ExperimentDocument>,
      executions: histories.collection as unknown as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunks.collection,
    });

    await expect(store.findExpectedPairs("project-1", [])).resolves.toEqual(
      new Set(),
    );
    expect(roots.find).not.toHaveBeenCalled();
    expect(chunks.find).not.toHaveBeenCalled();
    expect(histories.find).not.toHaveBeenCalled();
  });
});
