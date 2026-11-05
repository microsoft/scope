// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SharedRunView } from "./SharedRunView";
import { summaryRun } from "./fixtures";

afterEach(cleanup);

it("does not present a prior pass as the final score when the last turn has no evaluation", () => {
  render(<SharedRunView data={{
    ...summaryRun,
    run: { ...summaryRun.run, turns: [
      ...summaryRun.run.turns,
      { iteration: 2, gate: "select", timestamp: "2026-01-01T00:01:00.000Z", passed: false, criteriaResults: [] },
    ] },
  }} />);
  expect(screen.getByText("Not evaluated")).toBeDefined();
  expect(screen.queryByText("1 / 1 passed")).toBeNull();
});
