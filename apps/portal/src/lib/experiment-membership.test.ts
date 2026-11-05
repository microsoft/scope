// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { Run } from "@/types";
import { getExistingRunMembershipEligibility } from "./experiment-membership";

const run = (id: string, experimentId?: string): Run => ({
  _id: id,
  id,
  workerType: "copilot",
  createdAt: "2026-10-16T00:00:00.000Z",
  experimentId,
});

describe("existing-run Experiment eligibility", () => {
  it("allows a fully loaded standalone selection", () => {
    expect(
      getExistingRunMembershipEligibility(
        new Set(["request-1", "request-2"]),
        [run("request-1"), run("request-2")],
      ),
    ).toEqual({ eligible: true, assignedCount: 0 });
  });

  it("disables and explains selections containing an Experiment member", () => {
    const result = getExistingRunMembershipEligibility(
      new Set(["request-1", "request-2"]),
      [run("request-1"), run("request-2", "experiment-1")],
    );

    expect(result.eligible).toBe(false);
    expect(result.assignedCount).toBe(1);
    expect(result.reason).toContain("already assigned");
  });
});
