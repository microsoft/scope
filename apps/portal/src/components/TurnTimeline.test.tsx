// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { TurnTimeline } from "./TurnTimeline";
import type { ConversationTurn } from "@/types";

/** Build a minimal completed turn for the timeline. */
function makeTurn(iteration: number, overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    iteration,
    judgeFeedback: "",
    snapshotUrl: `https://blob/snapshot-${iteration}.tar.gz`,
    passed: false,
    timestamp: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("TurnTimeline — workspace snapshot size (#1564)", () => {
  afterEach(() => cleanup());

  it("shows the formatted size with the exact byte count as a tooltip", () => {
    render(<TurnTimeline runId="run-1" turns={[makeTurn(1, { workspaceSizeBytes: 1536 })]} />);

    const size = screen.getByText("1.5 KB");
    expect(size.getAttribute("title")).toContain("1,536 bytes");
  });

  it("shows 'size unavailable' for a turn without a recorded size", () => {
    render(<TurnTimeline runId="run-1" turns={[makeTurn(1)]} />);

    expect(screen.getByText("size unavailable")).toBeTruthy();
    expect(screen.queryByText("0 B")).toBeNull();
  });

  it("shows a recorded size of zero bytes as 0 B", () => {
    render(<TurnTimeline runId="run-1" turns={[makeTurn(1, { workspaceSizeBytes: 0 })]} />);

    expect(screen.getByText("0 B")).toBeTruthy();
  });

  it("omits the size when the turn has no snapshot", () => {
    render(<TurnTimeline runId="run-1" turns={[makeTurn(1, { snapshotUrl: "" })]} />);

    expect(screen.queryByText("size unavailable")).toBeNull();
  });
});
