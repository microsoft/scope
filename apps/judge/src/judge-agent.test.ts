// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getCriteriaProvider } = vi.hoisted(() => ({
  getCriteriaProvider: vi.fn(),
}));

vi.mock("shared/criteria-provider-factory", () => ({ getCriteriaProvider }));

import { assertProjectScope, evaluateWorkspace } from "./judge-agent.js";

describe("judge project scope (#1303)", () => {
  const originalApiUrl = process.env.CRITERIA_API_URL;

  beforeEach(() => {
    getCriteriaProvider.mockReset();
  });

  afterEach(() => {
    if (originalApiUrl === undefined) delete process.env.CRITERIA_API_URL;
    else process.env.CRITERIA_API_URL = originalApiUrl;
  });

  it("rejects an unscoped evaluation when criteria come from the REST API", async () => {
    process.env.CRITERIA_API_URL = "http://api.test";

    await expect(
      evaluateWorkspace({ workspacePath: "/tmp/ws", criteria: ["c1"], conversationHistory: [] }),
    ).rejects.toThrow("has no projectId");

    // The global provider must never be consulted.
    expect(getCriteriaProvider).not.toHaveBeenCalled();
  });

  it("resolves criteria from the run's project when scoped", async () => {
    process.env.CRITERIA_API_URL = "http://api.test";
    getCriteriaProvider.mockReturnValue({
      resolveWithAncestors: vi.fn().mockRejectedValue(new Error("stop here")),
    });

    await expect(
      evaluateWorkspace({ workspacePath: "/tmp/ws", criteria: ["c1"], conversationHistory: [], projectId: "proj-1" }),
    ).rejects.toThrow("stop here");

    expect(getCriteriaProvider).toHaveBeenCalledWith("proj-1");
  });

  it("allows an unscoped evaluation with the single-tenant filesystem provider", () => {
    delete process.env.CRITERIA_API_URL;

    expect(() => assertProjectScope(undefined)).not.toThrow();
  });
});
