// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { SubmissionLink } from "./SubmissionLink";
import { Default } from "./SubmissionLink.stories";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderLink(onRowClick = vi.fn(), onRowKeyDown = vi.fn()) {
  return render(
    <MemoryRouter>
      <div onClick={onRowClick} onKeyDown={onRowKeyDown}>
        <SubmissionLink submissionId="abcdef12-3456" projectId="project-alpha" />
      </div>
    </MemoryRouter>,
  );
}

describe("SubmissionLink", () => {
  it("copies a complete project-aware URL without opening the row", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const onRowClick = vi.fn();
    renderLink(onRowClick);
    await user.click(screen.getByRole("button", { name: /copy link/i }));
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/runs?projectId=project-alpha&submissionId=abcdef12-3456&groupBy=profile`,
    );
    expect(toast.success).toHaveBeenCalledWith("Submission link copied");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("opens the submission instead of the ancestor run", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderLink(onRowClick);
    await user.click(screen.getByRole("link", { name: /view submission/i }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("keeps keyboard activation from triggering an ancestor row", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const onRowClick = vi.fn();
    const onRowKeyDown = vi.fn();
    renderLink(onRowClick, onRowKeyDown);
    screen.getByRole("button", { name: /copy link/i }).focus();
    await user.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(onRowKeyDown).not.toHaveBeenCalled();
  });

  it("reports clipboard failure rather than claiming success", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Permission denied"));
    renderLink();
    await user.click(screen.getByRole("button", { name: /copy link/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "Could not copy submission link",
      { description: "Permission denied" },
    ));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("reports unavailable clipboard access", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { clipboard: undefined });
    renderLink();
    await user.click(screen.getByRole("button", { name: /copy link/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("passes the Storybook interaction", async () => {
    const { container } = render(
      <MemoryRouter>
        <SubmissionLink
          submissionId="abcdef12-3456-7890-abcd-ef1234567890"
          projectId="project-alpha"
        />
      </MemoryRouter>,
    );
    await Default.play?.({ canvas: within(container) } as Parameters<NonNullable<typeof Default.play>>[0]);
  });
});
