// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_SHARE_HEADER } from "shared/run-sharing";
import { exampleToken, summaryRun, fullRun } from "@/components/run-sharing/fixtures";
import { SharedRunPage } from "./SharedRun";

let requests: Request[] = [];
let responseData = structuredClone(summaryRun);
let viewStatus = 200;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><SharedRunPage /></QueryClientProvider>);
  return client;
}

beforeEach(() => {
  requests = [];
  responseData = structuredClone(summaryRun);
  viewStatus = 200;
  window.history.replaceState(null, "", `/shared/runs#${exampleToken}`);
  vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
    requests.push(req);
    const path = new URL(req.url).pathname;
    if (path.endsWith("/view")) return response(viewStatus === 200 ? responseData : { error: "Unavailable" }, viewStatus);
    if (path.endsWith("/logs")) return response({ events: [], truncated: false });
    if (path.endsWith("/reports")) return response({
      data: [{
        id: "report-1", label: "Generated report", createdAt: "2026-01-01T00:00:00.000Z",
        content: '# Report\n<script>window.compromised = true</script>\n![external](https://external.invalid/pixel)\n[private link](/runs/private)',
      }], next: null,
    });
    throw new Error("Unexpected request");
  }));
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("anonymous shared run viewer", () => {
  it("reads without credentials and never loads private providers, metadata, or actions", async () => {
    mount();
    await screen.findByText("React benchmark");
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/api/v1/shared/runs/view");
    expect(requests[0].headers.get(RUN_SHARE_HEADER)).toBe(exampleToken);
    expect(requests[0].headers.has("Authorization")).toBe(false);
    expect(requests[0].credentials).toBe("omit");
    expect(requests[0].referrerPolicy).toBe("no-referrer");
    expect(requests[0].url).not.toContain(exampleToken);
    for (const tab of ["Prompts", "Conversations", "Logs", "Reports", "Artifacts"]) {
      expect(screen.queryByRole("tab", { name: tab })).toBeNull();
    }
    for (const action of ["Retry", "Cancel", "Pause", "Resume", "Generate report", "Share"]) {
      expect(screen.queryByRole("button", { name: action })).toBeNull();
    }
  });

  it("does not request anything for an invalid or missing fragment", () => {
    window.history.replaceState(null, "", "/shared/runs#bad");
    mount();
    expect(screen.getByRole("alert").textContent).toContain("Shared run is unavailable");
    expect(requests).toHaveLength(0);
  });

  it("loads detailed content only through permitted public endpoints and keeps reports inert", async () => {
    responseData = structuredClone(fullRun);
    mount();
    await screen.findByText("React benchmark");
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Prompts" }));
    expect(screen.getByText(fullRun.prompts![0].text!)).toBeDefined();
    await user.click(screen.getByRole("tab", { name: "Reports" }));
    await screen.findByText("Generated report");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector('a[href="/runs/private"]')).toBeNull();
    expect(requests.every((req) => new URL(req.url).pathname.startsWith("/api/v1/shared/runs/"))).toBe(true);
  });

  it("clears previously visible content when the link becomes unavailable", async () => {
    responseData = structuredClone(fullRun);
    const client = mount();
    await screen.findByText("React benchmark");
    viewStatus = 404;
    await act(async () => { await client.invalidateQueries({ queryKey: ["public-run"] }); });
    await screen.findByText("Shared run is unavailable");
    expect(screen.queryByText("React benchmark")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Prompts" })).toBeNull();
  });

  it("removes disabled sections after a policy update instead of retaining cached private text", async () => {
    responseData = structuredClone(fullRun);
    const client = mount();
    await screen.findByText("React benchmark");
    await userEvent.setup().click(screen.getByRole("tab", { name: "Prompts" }));
    expect(screen.getByText(fullRun.prompts![0].text!)).toBeDefined();
    responseData = structuredClone(summaryRun);
    await act(async () => { await client.invalidateQueries({ queryKey: ["public-run"] }); });
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Prompts" })).toBeNull());
    expect(screen.queryByText(fullRun.prompts![0].text!)).toBeNull();
  });
});
