// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FULL_SHARE_CONTENT } from "shared/run-sharing";
import { api } from "@/lib/api";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth, signedOutAuth } from "@/contexts/authFixtures";
import { exampleShare, exampleToken } from "./fixtures";
import { ShareRunButton, ShareRunDialog } from "./ShareRunDialog";

const props = { requestId: "demo-request", runId: "demo-attempt", attemptNumber: 1 };
function mountDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShareRunDialog {...props} open onOpenChange={vi.fn()} /></QueryClientProvider>);
}
beforeEach(() => {
  vi.spyOn(api, "listRunShares").mockResolvedValue({ data: [], next: null });
  vi.spyOn(api, "createRunShare").mockResolvedValue({ share: exampleShare, path: `/shared/runs#${exampleToken}` });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("share publishing", () => {
  it("defaults to Summary and exposes the newly minted URL without requiring detailed consent", async () => {
    mountDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(api.createRunShare).toHaveBeenCalledWith("demo-request", "demo-attempt", expect.objectContaining({
      content: exampleShare.content, acknowledgeSensitiveContent: false,
    })));
    const input = await screen.findByRole("textbox", { name: "Shared URL" });
    expect((input as HTMLInputElement).value).toContain(`/shared/runs#${exampleToken}`);
  });

  it("requires acknowledgment for Full detail and keeps sensitive artifacts opt-in", async () => {
    mountDialog();
    fireEvent.click(screen.getByRole("button", { name: "Full detail" }));
    const create = screen.getByRole("button", { name: "Create link" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Source archives/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: /Videos/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(create);
    expect(api.createRunShare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed/ }));
    fireEvent.click(create);
    await waitFor(() => expect(api.createRunShare).toHaveBeenCalledWith("demo-request", "demo-attempt", expect.objectContaining({
      content: FULL_SHARE_CONTENT, acknowledgeSensitiveContent: true,
    })));
  });

  it("resets consent when another content category is added", () => {
    mountDialog();
    fireEvent.click(screen.getByRole("button", { name: "Full detail" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed/ }));
    expect((screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /Source archives/ }));
    expect((screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("supports editing, rotating, and revoking your existing links", async () => {
    vi.mocked(api.listRunShares).mockResolvedValue({ data: [exampleShare], next: null });
    vi.spyOn(api, "updateRunShare").mockResolvedValue({ ...exampleShare, label: "Updated" });
    vi.spyOn(api, "rotateRunShare").mockResolvedValue({ share: exampleShare, path: `/shared/runs#${exampleToken}` });
    vi.spyOn(api, "revokeRunShare").mockImplementation(async () => {
      vi.mocked(api.listRunShares).mockResolvedValue({ data: [{ ...exampleShare, revokedAt: "2026-01-02T00:00:00.000Z" }], next: null });
      return { ...exampleShare, revokedAt: "2026-01-02T00:00:00.000Z" };
    });
    mountDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Edit React benchmark" }));
    fireEvent.change(screen.getByLabelText("Link label"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(api.updateRunShare).toHaveBeenCalledWith("demo-request", "demo-attempt", exampleShare.id, expect.objectContaining({ label: "Updated" })));
    await waitFor(() => expect((screen.getByRole("button", { name: "Rotate React benchmark" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Rotate React benchmark" }));
    await screen.findByRole("textbox", { name: "Shared URL" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Revoke React benchmark" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Revoke React benchmark" }));
    await screen.findByText("Revoked");
    expect(screen.queryByRole("textbox", { name: "Shared URL" })).toBeNull();
  });

  it("hides publication for signed-out users and disabled installations", async () => {
    const version = vi.spyOn(api, "getVersion").mockResolvedValue({ commit: "test", buildTime: "test", runSharingEnabled: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(<QueryClientProvider client={client}>
      <AuthContext.Provider value={signedOutAuth}><ShareRunButton {...props} /></AuthContext.Provider>
    </QueryClientProvider>);
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(version).not.toHaveBeenCalled();
    rerender(<QueryClientProvider client={client}>
      <AuthContext.Provider value={signedInAuth}><ShareRunButton {...props} /></AuthContext.Provider>
    </QueryClientProvider>);
    await waitFor(() => expect(version).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });
});
