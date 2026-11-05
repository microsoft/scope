// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { submissionResultsPath, submittedRunPath } from "./submission-links";

describe("submission results links", () => {
  it("includes the project, full submission ID, and profile grouping", () => {
    const url = new URL(submissionResultsPath("submission/a & b", "project/one"), "https://scope.example");
    expect(url.pathname).toBe("/runs");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      projectId: "project/one",
      submissionId: "submission/a & b",
      groupBy: "profile",
    });
  });

  it("opens the entire fan-out submission rather than an unfiltered list", () => {
    expect(submittedRunPath({ ids: ["run-1", "run-2"], submissionId: "submission-1" }, "project-1"))
      .toBe(submissionResultsPath("submission-1", "project-1"));
  });

  it("handles a batch response containing only one run", () => {
    expect(submittedRunPath({ ids: ["run-1"], submissionId: "submission-1" }, "project-1"))
      .toBe(submissionResultsPath("submission-1", "project-1"));
  });

  it("preserves single-run detail navigation", () => {
    expect(submittedRunPath({ id: "run-1", submissionId: "submission-1" }, "project-1"))
      .toBe("/runs/run-1");
  });

  it("preserves the legacy batch fallback without building an unscoped link", () => {
    expect(submittedRunPath({ ids: ["run-1"] }, "project-1")).toBe("/runs");
    expect(submittedRunPath({ ids: ["run-1"], submissionId: "submission-1" }, undefined)).toBe("/runs");
  });
});
