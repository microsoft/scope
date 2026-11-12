// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { parseScopeAtif } from "../scope-atif.js";
import { requiresCompleteTrajectory } from "./requires-complete-trajectory.js";

function atif(state?: "complete" | "partial" | "unknown") {
  return parseScopeAtif({
    schema_version: "ATIF-v1.7",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [],
    ...(state
      ? {
        extra: {
          scope: {
            schema_version: "scope.atif-extension.v1",
            trajectory_state: state,
            available_sources: [],
          },
        },
      }
      : {}),
  });
}

describe("requires_complete_trajectory precondition", () => {
  it.each([
    ["disabled partial", false, "partial", undefined],
    ["enabled complete", true, "complete", undefined],
    ["enabled partial", true, "partial", "indeterminate"],
    ["enabled unknown", true, "unknown", "indeterminate"],
  ] as const)("%s", (_label, enabled, state, expectedState) => {
    const result = requiresCompleteTrajectory(enabled, atif(state), "Element");
    if (!expectedState) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toMatchObject({ state: expectedState });
    }
  });

  it("treats missing trajectory state as complete", () => {
    expect(requiresCompleteTrajectory(true, atif(), "Element"))
      .toBeUndefined();
  });
});
