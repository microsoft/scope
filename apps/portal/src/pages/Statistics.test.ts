// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { runsLinkFor } from "./Statistics";
import type { TaskWorkerGroup } from "@/types";

function makeGroup(overrides: Partial<TaskWorkerGroup> = {}): TaskWorkerGroup {
  return {
    task: "Hello world",
    taskPromptId: "5983ca73-583e-5624-aa68-2752c77973d9",
    workerType: "coder-acp-copilot",
    total: 3,
    completed: 3,
    passed: 0,
    rejected: 3,
    passAtK: {},
    successAtT: [],
    iterationStats: null,
    durationStats: null,
    ...overrides,
  };
}

describe("runsLinkFor", () => {
  it("emits worker + taskPromptId in the URL with no extras", () => {
    const link = runsLinkFor(makeGroup());
    const url = new URL(link, "http://x");
    expect(url.pathname).toBe("/runs");
    expect(url.searchParams.get("worker")).toBe("coder-acp-copilot");
    expect(url.searchParams.get("taskPromptId")).toBe(
      "5983ca73-583e-5624-aa68-2752c77973d9",
    );
  });

  it("appends a single-value extra filter", () => {
    const link = runsLinkFor(makeGroup(), { outcome: "failed" });
    const url = new URL(link, "http://x");
    expect(url.searchParams.get("outcome")).toBe("failed");
  });

  // The runs list parses multi-value filters as a comma-separated list (see
  // `useListUrlState.getFilterList`). Bug #1026: when the Needs-attention
  // CTA only sent `outcome=failed` it dropped runs whose final outcome was
  // `finished` (max iterations reached), even though the Statistics page
  // counts both as failures. Arrays must therefore be serialized as a
  // comma-joined value, not as repeated `?key=` params.
  it("joins array-valued extras with commas (multi-value filter)", () => {
    const link = runsLinkFor(makeGroup(), {
      outcome: ["failed", "finished"],
    });
    const url = new URL(link, "http://x");
    expect(url.searchParams.get("outcome")).toBe("failed,finished");
    expect(url.searchParams.getAll("outcome")).toEqual(["failed,finished"]);
  });

  it("skips empty-array extras instead of emitting an empty value", () => {
    const link = runsLinkFor(makeGroup(), { outcome: [] });
    const url = new URL(link, "http://x");
    expect(url.searchParams.has("outcome")).toBe(false);
  });
});
