// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortal } from "react-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { McpServerDocument } from "@/types";

const seed: McpServerDocument[] = [
  {
    _id: "learn-docs",
    name: "Learn Docs",
    type: "http",
    url: "https://learn.example.com/mcp",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];
let servers: McpServerDocument[] = [...seed];

vi.mock("@/lib/api", () => ({
  api: {
    listMcpServers: vi.fn(async () => servers),
    createMcpServer: vi.fn(async (body: { _id: string; name: string; type: McpServerDocument["type"]; url?: string }) => {
      const created: McpServerDocument = { ...body, createdAt: "2026-01-02T00:00:00.000Z" };
      servers = [...servers, created];
      return created;
    }),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from "@/lib/api";
import { McpServerForm } from "./McpServerForm";
import { McpServerCreateDialog } from "./McpServerCreateDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  servers = [...seed];
});

function renderWithClient(
  ui: React.ReactElement,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function fillValidHttpServer(slug: string) {
  // Wait for the existing-server list to load so duplicate detection is live.
  await waitFor(() => expect(api.listMcpServers).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: slug } });
  fireEvent.change(screen.getByLabelText(/^url/i), { target: { value: "https://example.com/mcp" } });
}

describe("McpServerForm", () => {
  it("blocks a slug that already exists in the project", async () => {
    renderWithClient(<McpServerForm onCreated={vi.fn()} />);
    await fillValidHttpServer("learn-docs");

    expect(await screen.findByText(/already exists in this project/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /create server/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates the server, seeds the shared list, and reports it upward", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Capture the cache at callback time: callers rely on the new server already
    // being in the list when they auto-select it.
    let cachedAtCallback: string[] = [];
    const onCreated = vi.fn(() => {
      cachedAtCallback = (queryClient.getQueryData<McpServerDocument[]>(["mcp-servers"]) ?? []).map((s) => s._id);
    });
    renderWithClient(<McpServerForm onCreated={onCreated} />, queryClient);
    await fillValidHttpServer("new-server");

    const submit = screen.getByRole("button", { name: /create server/i }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.submit(submit.closest("form")!);

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createMcpServer).mock.calls[0][0]).toMatchObject({
      _id: "new-server",
      name: "New Server",
      type: "http",
      url: "https://example.com/mcp",
    });
    expect(onCreated.mock.calls[0]).toEqual([expect.objectContaining({ _id: "new-server" })]);
    expect(cachedAtCallback).toEqual(["new-server", "learn-docs"]);
  });

  it("does not propagate submit to an enclosing page form across a portal", async () => {
    const outerSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    renderWithClient(
      <form onSubmit={outerSubmit}>
        {createPortal(<McpServerForm onCreated={vi.fn()} />, document.body)}
      </form>,
    );
    await fillValidHttpServer("portal-server");

    const submit = screen.getByRole("button", { name: /create server/i });
    fireEvent.submit(submit.closest("form")!);

    await waitFor(() => expect(api.createMcpServer).toHaveBeenCalledTimes(1));
    expect(outerSubmit).not.toHaveBeenCalled();
  });
});

describe("McpServerCreateDialog", () => {
  it("claims Cmd/Ctrl+Enter so page-level shortcuts do not fire underneath", async () => {
    const pageShortcut = vi.fn();
    const listener = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === "Enter") pageShortcut();
    };
    document.addEventListener("keydown", listener);
    try {
      renderWithClient(<McpServerCreateDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
      const slug = await screen.findByLabelText(/slug/i);
      fireEvent.keyDown(slug, { key: "Enter", metaKey: true, ctrlKey: true });
      expect(pageShortcut).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });
});
