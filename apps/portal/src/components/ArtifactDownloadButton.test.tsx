// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactDownloadButton } from "./ArtifactDownloadButton";
import { downloadArtifact, downloadBatchArtifacts } from "@/lib/artifact-delivery";
import { setApiSessionSignal, resetApiClient } from "@/lib/api-client";
import { toast } from "sonner";

const state = vi.hoisted(() => ({
  project: "p1" as string | undefined,
  auth: { isReady: true, user: { id: "u1" }, account: null },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => state.auth }));
vi.mock("@/contexts/ProjectContext", () => ({ useSelectedProjectId: () => state.project }));
vi.mock("@/lib/artifact-delivery", () => ({ downloadArtifact: vi.fn(), downloadBatchArtifacts: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const firstUrl = "/api/v1/requests/r/runs/a/archive";
beforeEach(() => {
  state.project = "p1";
  state.auth.isReady = true;
  vi.clearAllMocks();
});
afterEach(() => { cleanup(); resetApiClient(); });

describe("artifact download action", () => {
  it("guards repeated clicks, exposes pending/cancel, and reports completion", async () => {
    let finish!: () => void;
    vi.mocked(downloadArtifact).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = vi.fn();
    const parent = vi.fn();
    render(<div onClick={parent}><ArtifactDownloadButton url={firstUrl} onPendingChange={pending}>Archive</ArtifactDownloadButton></div>);
    const button = screen.getByRole("button", { name: "Archive" });
    act(() => { button.click(); button.click(); });
    expect(downloadArtifact).toHaveBeenCalledTimes(1);
    expect(parent).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel download" })).toBeDefined();
    await act(async () => finish());
    expect(pending.mock.calls).toEqual([[true], [false]]);
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("cancels deliberately without displaying a failure", async () => {
    vi.mocked(downloadArtifact).mockImplementation((_url, _project, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    render(<ArtifactDownloadButton url={firstUrl}>Archive</ArtifactDownloadButton>);
    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel download" })).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("surfaces permanent failures instead of pretending to finish a file", async () => {
    vi.mocked(downloadArtifact).mockRejectedValue(new Error("HTTP 403: access denied"));
    render(<ArtifactDownloadButton url={firstUrl}>Archive</ArtifactDownloadButton>);
    fireEvent.click(screen.getByText("Archive"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("HTTP 403: access denied"));
    expect(screen.getByText("Archive").closest("button")?.disabled).toBe(false);
  });

  it.each(["project", "attempt", "account", "unmount"] as const)("cancels stale operations on %s without stale error UI", async change => {
    let fail!: (reason: Error) => void;
    let signal!: AbortSignal;
    const account = new AbortController();
    setApiSessionSignal(account.signal);
    vi.mocked(downloadArtifact).mockImplementation((_url, _project, scoped) => {
      signal = scoped;
      return new Promise((_, reject) => { fail = reject; });
    });
    const { rerender, unmount } = render(<ArtifactDownloadButton url={firstUrl}>Archive</ArtifactDownloadButton>);
    fireEvent.click(screen.getByText("Archive"));
    if (change === "project") state.project = "p2";
    if (change === "account") account.abort();
    if (change === "unmount") unmount();
    else rerender(<ArtifactDownloadButton url={change === "attempt" ? `${firstUrl}?iteration=2` : firstUrl}>Archive</ArtifactDownloadButton>);
    expect(signal.aborted).toBe(true);
    await act(async () => fail(new Error("Late old-account error")));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("binds a batch to its selected IDs and cancels when that selection changes", () => {
    vi.mocked(downloadBatchArtifacts).mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(<ArtifactDownloadButton url="/api/v1/requests/archive" batchIds={["a", "b"]}>Batch</ArtifactDownloadButton>);
    fireEvent.click(screen.getByText("Batch"));
    expect(downloadBatchArtifacts).toHaveBeenCalledWith(["a", "b"], "p1", expect.any(AbortSignal));
    const signal = vi.mocked(downloadBatchArtifacts).mock.calls[0][2];
    rerender(<ArtifactDownloadButton url="/api/v1/requests/archive" batchIds={["b"]}>Batch</ArtifactDownloadButton>);
    expect(signal.aborted).toBe(true);
  });

  it("does not allow a download before auth/project readiness", () => {
    state.auth.isReady = false;
    state.project = undefined;
    render(<ArtifactDownloadButton url={firstUrl}>Archive</ArtifactDownloadButton>);
    fireEvent.click(screen.getByText("Archive"));
    expect(downloadArtifact).not.toHaveBeenCalled();
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });
});
