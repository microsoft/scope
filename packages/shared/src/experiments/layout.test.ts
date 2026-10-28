// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_STORAGE_PROFILE,
  bsonSize,
  selectFixedPayloadLayout,
} from "./layout.js";
import type { ExperimentRequestState } from "./types.js";

function request(index: number, error = ""): ExperimentRequestState {
  return {
    requestId: `request-${index}`,
    runId: `run-${index}`,
    dependencies: [
      {
        handlerId: "observations",
        state: "ready",
        ...(error ? { error } : {}),
      },
    ],
    blockers: [],
  };
}

describe("experiment fixed payload layout", () => {
  it("chooses inline at the exact target and chunks one byte above it", () => {
    const entries = [request(1)];
    const base = bsonSize({ entries, padding: "" });
    const exactPadding = "x".repeat(
      EXPERIMENT_STORAGE_PROFILE.targetDocumentBytes - base,
    );
    const exact = selectFixedPayloadLayout({
      entries,
      inlineDocument: (value) => ({ entries: value, padding: exactPadding }),
      chunkDocument: (chunkIndex, bucketCount, value) => ({
        chunkIndex,
        bucketCount,
        entries: value,
      }),
    });
    expect(exact.bsonBytes[0]).toBe(
      EXPERIMENT_STORAGE_PROFILE.targetDocumentBytes,
    );
    expect(exact.storage).toBe("inline");

    const adjacent = selectFixedPayloadLayout({
      entries,
      inlineDocument: (value) => ({
        entries: value,
        padding: `${exactPadding}x`,
      }),
      chunkDocument: (chunkIndex, bucketCount, value) => ({
        chunkIndex,
        bucketCount,
        entries: value,
      }),
    });
    expect(adjacent.storage).toBe("chunked");
    expect(adjacent.bucketCount).toBe(1);
  });

  it("selects the first safe bucket count after recomputing distribution", () => {
    const entries = Array.from({ length: 120 }, (_, index) =>
      request(index, "x".repeat(3_000)),
    );
    const layout = selectFixedPayloadLayout({
      entries,
      inlineDocument: (value) => ({
        entries: value,
        padding: "x".repeat(EXPERIMENT_STORAGE_PROFILE.targetDocumentBytes),
      }),
      chunkDocument: (chunkIndex, bucketCount, value) => ({
        chunkIndex,
        bucketCount,
        entries: value,
      }),
    });
    expect(layout.storage).toBe("chunked");
    // Three is the count-only lower bound; the hash distribution overloads
    // one bucket, so four is the first count that satisfies the BSON budget.
    expect(layout.bucketCount).toBe(4);
    expect(layout.bsonBytes.every((size) => size < 256 * 1024)).toBe(true);
  });

  it("rejects oversized entries and duplicate request ids", () => {
    const oversized = request(1, "x".repeat(4_096));
    expect(() =>
      selectFixedPayloadLayout({
        entries: [oversized],
        inlineDocument: (entries) => ({ entries }),
        chunkDocument: (chunkIndex, bucketCount, entries) => ({
          chunkIndex,
          bucketCount,
          entries,
        }),
      }),
    ).toThrow(/maximum/);
    expect(() =>
      selectFixedPayloadLayout({
        entries: [request(1), request(1)],
        inlineDocument: (entries) => ({ entries }),
        chunkDocument: (chunkIndex, bucketCount, entries) => ({
          chunkIndex,
          bucketCount,
          entries,
        }),
      }),
    ).toThrow(/Duplicate/);
  });
});
