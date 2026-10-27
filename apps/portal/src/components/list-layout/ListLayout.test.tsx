// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeStories } from "@storybook/react-vite";
import { useIsCompactViewport } from "@/hooks/useMediaQuery";
import { ListLayout } from "./ListLayout";
import * as stories from "./ListLayout.stories";

vi.mock("@/hooks/useMediaQuery", () => ({
  useIsCompactViewport: vi.fn(() => false),
}));

beforeEach(() => {
  vi.mocked(useIsCompactViewport).mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ListLayout", () => {
  it("renders title/children and persists rail collapse", () => {
    render(
      <ListLayout
        title="Runs"
        description="Run list"
        filterRail={<div>filters</div>}
        railStorageKey="runs"
      >
        <div>table-content</div>
      </ListLayout>,
    );

    expect(screen.getByText("Runs")).toBeTruthy();
    expect(screen.getByText("table-content")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open filters" }).querySelector(".lucide-list"),
    ).toBeTruthy();
    expect(localStorage.getItem("scope:list-layout:runs:rail-collapsed")).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Hide filters" }));
    expect(localStorage.getItem("scope:list-layout:runs:rail-collapsed")).toBe("1");
  });

  it("updates the section icon when the list changes", () => {
    const { rerender } = render(
      <ListLayout title="Runs" filterRail={<div>filters</div>} railStorageKey="runs">
        <div>table-content</div>
      </ListLayout>,
    );
    expect(
      screen.getByRole("button", { name: "Open filters" }).querySelector(".lucide-list"),
    ).toBeTruthy();

    rerender(
      <ListLayout title="Reports" filterRail={<div>filters</div>} railStorageKey="reports">
        <div>table-content</div>
      </ListLayout>,
    );
    expect(
      screen.getByRole("button", { name: "Open filters" }).querySelector(".lucide-file-text"),
    ).toBeTruthy();
  });

  it.each([undefined, "", "custom-list", "__proto__", "constructor", "toString"])(
    "preserves the generic filter icon for storage key %s",
    (railStorageKey) => {
      render(
        <ListLayout title="Custom list" filterRail={<div>filters</div>} railStorageKey={railStorageKey}>
          <div>table-content</div>
        </ListLayout>,
      );
      expect(
        screen.getByRole("button", { name: "Open filters" }).querySelector(".lucide-sliders-horizontal"),
      ).toBeTruthy();
    },
  );

  it("opens the compact filter sheet from the section icon", () => {
    vi.mocked(useIsCompactViewport).mockReturnValue(true);
    render(
      <ListLayout title="Reports" filterRail={<div>filters</div>} railStorageKey="reports">
        <div>table-content</div>
      </ListLayout>,
    );
    const trigger = screen.getByRole("button", { name: "Open filters" });
    expect(trigger.getAttribute("title")).toBe("Open filters");
    expect(trigger.querySelector(".lucide-file-text")).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
  });

  it("does not add filter controls when there is no rail", () => {
    render(
      <ListLayout title="Reports" filterRail={null} railStorageKey="reports">
        <div>table-content</div>
      </ListLayout>,
    );
    expect(screen.queryByRole("button", { name: "Open filters" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide filters" })).toBeNull();
  });

  it("honors stored collapsed state on first render", () => {
    localStorage.setItem("scope:list-layout:runs:rail-collapsed", "1");

    render(
      <ListLayout
        title="Runs"
        filterRail={<div>filters</div>}
        railStorageKey="runs"
      >
        <div>table-content</div>
      </ListLayout>,
    );

    expect(screen.getByRole("button", { name: "Show filters" })).toBeTruthy();
  });
});

describe("ListLayout stories", () => {
  for (const [name, Story] of Object.entries(composeStories(stories))) {
    it(`${name} renders and play passes`, async () => {
      const { container } = render(<Story />);
      await Story.play?.({ canvas: within(container), canvasElement: container });
    });
  }
});
