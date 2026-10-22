// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ShortId } from "./ShortId";

const FULL_ID = "abcdef1234567890fedcba";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ShortId trigger", () => {
  it("renders the first 8 characters by default", () => {
    render(<ShortId id={FULL_ID} />);
    expect(screen.getByText("abcdef12")).toBeTruthy();
    // The full id is not shown until the tooltip opens.
    expect(screen.queryByText(FULL_ID)).toBeNull();
  });

  it("respects a custom length", () => {
    render(<ShortId id={FULL_ID} length={4} />);
    expect(screen.getByText("abcd")).toBeTruthy();
  });

  it("shows the full submission ID on a detail page", () => {
    render(<ShortId id={FULL_ID} length={FULL_ID.length} label="submission ID" />);
    expect(screen.getByText(FULL_ID)).toBeTruthy();
  });
});

describe("ShortId hover + copy", () => {
  it("reveals the full id on hover", async () => {
    const user = userEvent.setup();
    render(<ShortId id={FULL_ID} />);
    await user.hover(screen.getByText("abcdef12"));
    await waitFor(() => {
      // Radix renders the content twice (visible + a11y copy); the full id
      // should be present at least once.
      expect(screen.getAllByText(FULL_ID).length).toBeGreaterThan(0);
    });
  });

  it("copies the full id to the clipboard and shows a copied state", async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs its own clipboard stub, so spy afterwards.
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<ShortId id={FULL_ID} />);
    await user.hover(screen.getByText("abcdef12"));
    const [button] = await screen.findAllByRole("button", { name: /copy/i });
    await user.click(button);
    expect(writeText).toHaveBeenCalledWith(FULL_ID);
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /copied/i }).length).toBeGreaterThan(0);
    });
  });

  it("does not bubble the copy click to an ancestor row onClick", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <ShortId id={FULL_ID} />
      </div>,
    );
    await user.hover(screen.getByText("abcdef12"));
    const [button] = await screen.findAllByRole("button", { name: /copy/i });
    await user.click(button);
    expect(writeText).toHaveBeenCalledWith(FULL_ID);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe("ShortId clipboard resilience", () => {
  it("does not throw or show a copied state when the clipboard write is blocked", async () => {
    const user = userEvent.setup();
    // Non-secure contexts / denied permissions reject the write.
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("denied"));
    render(<ShortId id={FULL_ID} />);
    await user.hover(screen.getByText("abcdef12"));
    const [button] = await screen.findAllByRole("button", { name: /copy/i });
    await expect(user.click(button)).resolves.not.toThrow();
    expect(writeText).toHaveBeenCalledWith(FULL_ID);
    // The handler swallows the rejection, so it never flips to the copied state.
    expect(screen.queryAllByRole("button", { name: /copied/i })).toHaveLength(0);
  });
});
