// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render as renderComponent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { LogViewer } from "./LogViewer";
import type { LogEvent } from "@/types";

function render(ui: ReactNode) {
  return renderComponent(ui, {
    wrapper: ({ children }) => (
      <AuthContext.Provider value={signedInAuth}>
        <ProjectProvider>{children}</ProjectProvider>
      </AuthContext.Provider>
    ),
  });
}

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const logs: LogEvent[] = [
  { timestamp: "2026-06-21T12:00:00.000Z", level: "info", message: "hello" },
  { timestamp: "2026-06-21T12:00:01.000Z", level: "info", message: "world" },
];

function getViewport(container: HTMLElement): HTMLElement {
  const el = container.querySelector("[data-radix-scroll-area-viewport]");
  if (!el) throw new Error("scroll-area viewport not found");
  return el as HTMLElement;
}

function setScrollMetrics(
  el: HTMLElement,
  m: { scrollHeight: number; clientHeight: number; scrollTop: number }
) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: m.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: m.clientHeight });
  Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: m.scrollTop });
}

describe("LogViewer auto-scroll behavior", () => {
  it("shows the auto-scrolling indicator when streaming and snapped to bottom", () => {
    render(
      <LogViewer runId="r1" logs={logs} isConnected isDone={false} error={null} />
    );
    expect(screen.queryByText(/auto-scrolling/i)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });

  it("shows no auto-scroll affordances when the stream is complete", () => {
    render(
      <LogViewer runId="r1" logs={logs} isConnected={false} isDone error={null} />
    );
    expect(screen.queryByText(/auto-scrolling/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });

  it("pauses auto-scroll and reveals 'Jump to latest' when the user scrolls up", () => {
    const { container } = render(
      <LogViewer runId="r1" logs={logs} isConnected isDone={false} error={null} />
    );
    const viewport = getViewport(container);
    // Simulate the user scrolling well away from the bottom.
    setScrollMetrics(viewport, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(viewport);

    expect(screen.queryByText(/auto-scrolling/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeNull();
  });

  it("resumes auto-scroll when 'Jump to latest' is clicked", () => {
    const { container } = render(
      <LogViewer runId="r1" logs={logs} isConnected isDone={false} error={null} />
    );
    const viewport = getViewport(container);
    setScrollMetrics(viewport, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(viewport);

    fireEvent.click(screen.getByRole("button", { name: /jump to latest/i }));

    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
    expect(screen.queryByText(/auto-scrolling/i)).not.toBeNull();
    // Jumping pins the viewport back to the bottom.
    expect(viewport.scrollTop).toBe(viewport.scrollHeight);
  });

  it("keeps following the tail while the user stays at the bottom", () => {
    const { container } = render(
      <LogViewer runId="r1" logs={logs} isConnected isDone={false} error={null} />
    );
    const viewport = getViewport(container);
    // Near-bottom within the threshold should still count as "at bottom".
    setScrollMetrics(viewport, { scrollHeight: 1000, clientHeight: 200, scrollTop: 790 });
    fireEvent.scroll(viewport);

    expect(screen.queryByText(/auto-scrolling/i)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });
});
