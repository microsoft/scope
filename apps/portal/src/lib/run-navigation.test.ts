// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  isSafeInternalReturnTarget,
  resolveRunReturnState,
  runNavigationState,
} from "./run-navigation";

describe("run navigation state", () => {
  it("preserves an internal return target and label", () => {
    expect(
      resolveRunReturnState(
        runNavigationState(
          "/experiments/experiment-1?tab=runs&executionId=execution-2",
          "Back to experiment",
        ),
      ),
    ).toEqual({
      returnTo:
        "/experiments/experiment-1?tab=runs&executionId=execution-2",
      returnLabel: "Back to experiment",
    });
  });

  it("preserves Runs query state", () => {
    expect(
      resolveRunReturnState(
        runNavigationState("/runs?groupBy=experimentId&page=2", "Back to runs"),
      ),
    ).toEqual({
      returnTo: "/runs?groupBy=experimentId&page=2",
      returnLabel: "Back to runs",
    });
  });

  it.each([
    undefined,
    null,
    {},
    { returnTo: "https://example.com", returnLabel: "External" },
    { returnTo: "//example.com", returnLabel: "External" },
    { returnTo: "\\\\example.com", returnLabel: "External" },
  ])("falls back safely for invalid state %#", (state) => {
    expect(resolveRunReturnState(state)).toEqual({
      returnTo: "/runs",
      returnLabel: "Back to runs",
    });
  });

  it("accepts only same-origin path targets", () => {
    expect(isSafeInternalReturnTarget("/runs?status=done")).toBe(true);
    expect(isSafeInternalReturnTarget("https://example.com/runs")).toBe(false);
  });
});
