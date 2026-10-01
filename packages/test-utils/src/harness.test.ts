// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { detectLastStep } from "./harness.js";

describe("detectLastStep", () => {
  it("returns the furthest step reached", () => {
    const logs = [
      "[00:00:00.000] [acp] Starting ACP agent: copilot --acp",
      "[00:00:01.000] [acp] Connected to agent",
      "[00:00:02.000] [acp] Created session abc",
    ];
    expect(detectLastStep(logs)).toBe("Created session");
  });

  it("returns undefined when no step was reached", () => {
    expect(detectLastStep(["[00:00:00.000] test-worker starting"])).toBeUndefined();
  });
});
