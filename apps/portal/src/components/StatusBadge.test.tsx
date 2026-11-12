// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OutcomeBadge, StatusBadge } from "./StatusBadge";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function getBadge(label: string): HTMLElement {
  // The Badge renders the label as text; there's one badge per render call
  // so this is sufficient to locate it.
  return screen.getByText(label);
}

describe("StatusBadge", () => {
  it("renders the configured label for each status", () => {
    const cases: Array<[Parameters<typeof StatusBadge>[0]["status"], string]> = [
      ["pending", "Pending"],
      ["queued", "Queued"],
      ["processing", "Processing"],
      ["paused", "Paused"],
      ["done", "Done"],
      ["completed", "Completed"],
      ["failed", "Failed"],
      ["cancelled", "Cancelled"],
      ["deleted", "Deleted"],
      ["missing", "Missing"],
    ];
    for (const [status, label] of cases) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeDefined();
      unmount();
    }
  });

  it("does not shimmer for non-processing statuses", () => {
    render(<StatusBadge status="paused" />);
    expect(getBadge("Paused").className).not.toContain("animate-shimmer");
  });

  it("shimmers while processing with no heartbeat yet", () => {
    render(<StatusBadge status="processing" />);
    expect(getBadge("Processing").className).toContain("animate-shimmer");
  });

  it("shimmers while processing with a fresh heartbeat", () => {
    vi.useFakeTimers();
    const now = new Date("2026-05-15T12:00:00.000Z");
    vi.setSystemTime(now);
    const heartbeat = new Date(now.getTime() - 5_000).toISOString();
    render(<StatusBadge status="processing" lastHeartbeatAt={heartbeat} />);
    expect(getBadge("Processing").className).toContain("animate-shimmer");
  });

  it("stops shimmering and dims when heartbeat is older than 30s", () => {
    vi.useFakeTimers();
    const now = new Date("2026-05-15T12:00:00.000Z");
    vi.setSystemTime(now);
    const stale = new Date(now.getTime() - 60_000).toISOString();
    render(<StatusBadge status="processing" lastHeartbeatAt={stale} />);
    const badge = getBadge("Processing");
    expect(badge.className).not.toContain("animate-shimmer");
    expect(badge.className).toContain("opacity-50");
  });

  it("stops shimmering and dims when no heartbeat and startedAt exceeds grace period", () => {
    vi.useFakeTimers();
    const now = new Date("2026-05-15T12:00:00.000Z");
    vi.setSystemTime(now);
    const staleStart = new Date(now.getTime() - 120_000).toISOString();
    render(<StatusBadge status="processing" startedAt={staleStart} />);
    const badge = getBadge("Processing");
    expect(badge.className).not.toContain("animate-shimmer");
    expect(badge.className).toContain("opacity-50");
  });

  it("does not dim when processing and shimmering", () => {
    render(<StatusBadge status="processing" />);
    const badge = getBadge("Processing");
    expect(badge.className).toContain("animate-shimmer");
    expect(badge.className).not.toContain("opacity-50");
  });

  it("falls back to outline variant for an unknown status", () => {
    // Cast through unknown to bypass the typed union — the runtime fallback
    // is what we want to verify.
    render(<StatusBadge status={"weird" as unknown as "pending"} />);
    expect(screen.getByText("weird")).toBeDefined();
  });
});

describe("OutcomeBadge", () => {
  it("renders a dash when no outcome is provided", () => {
    render(<OutcomeBadge />);
    expect(screen.getByText("–")).toBeDefined();
  });

  it("renders the configured label for each outcome", () => {
    const cases: Array<[Parameters<typeof OutcomeBadge>[0]["outcome"], string]> = [
      ["succeeded", "Succeeded"],
      ["failed", "Failed"],
      ["finished", "Finished"],
    ];
    for (const [outcome, label] of cases) {
      const { unmount } = render(<OutcomeBadge outcome={outcome} />);
      expect(screen.getByText(label)).toBeDefined();
      unmount();
    }
  });
});
