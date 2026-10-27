// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAllTurnsToolCalls, useHarData, useHarExtraction } from "./useHarExtraction";
import { fetchArtifact } from "@/lib/artifact-delivery";
import { setApiSessionSignal, resetApiClient } from "@/lib/api-client";
import type { ConversationTurn } from "@/types";

const state = vi.hoisted(() => ({
  project: "p1",
  auth: { isReady: true, user: { id: "u1" }, account: null },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => state.auth }));
vi.mock("@/contexts/ProjectContext", () => ({ useSelectedProjectId: () => state.project }));
vi.mock("@/lib/artifact-delivery", () => ({ fetchArtifact: vi.fn() }));
const har = { log: { entries: [] } };
const clients: QueryClient[] = [];
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const turn = (fields: Partial<ConversationTurn>): ConversationTurn => ({
  iteration: 1, passed: false, codingAgentResponse: "", judgeFeedback: "",
  snapshotUrl: "", timestamp: "2026-01-01T00:00:00Z", ...fields,
});

beforeEach(() => {
  state.project = "p1";
  state.auth.isReady = true;
  vi.mocked(fetchArtifact).mockReset();
  vi.mocked(fetchArtifact).mockImplementation(async () => Response.json(har));
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  resetApiClient();
});

describe("project/account/attempt-bound HAR display", () => {
  it("shares one immutable HAR query between display and extraction", async () => {
    const { result } = renderHook(() => ({
      raw: useHarData("r", 2, true, "attempt"),
      extracted: useHarExtraction("r", 2, true, "attempt"),
    }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.raw.isSuccess).toBe(true));
    expect(fetchArtifact).toHaveBeenCalledTimes(1);
    expect(fetchArtifact).toHaveBeenCalledWith("/api/v1/requests/r/runs/attempt/har?iteration=2", "p1", expect.any(AbortSignal));
    expect(result.current.extracted.data?.toolCalls).toEqual([]);
  });

  it("does not fetch before authentication is ready", () => {
    state.auth.isReady = false;
    renderHook(() => useHarData("r", 1), { wrapper: wrapper() });
    expect(fetchArtifact).not.toHaveBeenCalled();
  });

  it.each(["project", "attempt", "account"] as const)("isolates cached bytes on %s change", async change => {
    setApiSessionSignal(new AbortController().signal);
    const { result, rerender } = renderHook(({ attempt }) => useHarData("r", 1, true, attempt), {
      wrapper: wrapper(), initialProps: { attempt: "a1" },
    });
    await waitFor(() => expect(result.current.data).toEqual(har));
    vi.mocked(fetchArtifact).mockImplementation(() => new Promise(() => {}));
    if (change === "project") state.project = "p2";
    if (change === "account") setApiSessionSignal(new AbortController().signal);
    rerender({ attempt: change === "attempt" ? "a2" : "a1" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(fetchArtifact).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetchArtifact).mock.calls[0][2].aborted).toBe(true);
  });

  it("rejects late parsed bytes after account cancellation", async () => {
    const account = new AbortController();
    setApiSessionSignal(account.signal);
    let deliver!: (value: unknown) => void;
    vi.mocked(fetchArtifact).mockImplementation(async () => {
      const response = Response.json(har);
      vi.spyOn(response, "json").mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
      return response;
    });
    const { result } = renderHook(() => useHarData("r", 1), { wrapper: wrapper() });
    await waitFor(() => expect(deliver).toBeDefined());
    await act(async () => { account.abort(); deliver(har); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("hides already cached data as soon as readiness is lost", async () => {
    const { result, rerender } = renderHook(() => useHarData("r", 1), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toEqual(har));
    state.auth.isReady = false;
    rerender();
    expect(result.current.data).toBeUndefined();
  });

  it("surfaces HTTP failures and malformed HAR instead of an empty success", async () => {
    vi.mocked(fetchArtifact).mockRejectedValue(new Error("HTTP 403"));
    const first = renderHook(() => useHarExtraction("r", 1, true), { wrapper: wrapper() });
    await waitFor(() => expect(first.result.current.error?.message).toBe("HTTP 403"));
    expect(fetchArtifact).toHaveBeenCalledTimes(1);
    first.unmount();
    vi.mocked(fetchArtifact).mockResolvedValue(Response.json({ error: "not HAR" }));
    const second = renderHook(() => useHarExtraction("r2", 1, true), { wrapper: wrapper() });
    await waitFor(() => expect(second.result.current.error?.message).toContain("invalid HAR"));
  });

  it("uses attempt-specific JSONL and exposes invalid records", async () => {
    const tool = { id: "call", name: "read_file", arguments: { path: "file" }, timestamp: "2026-01-01" };
    vi.mocked(fetchArtifact).mockImplementation(async () => new Response(`${JSON.stringify(tool)}\n`));
    const first = renderHook(() => useAllTurnsToolCalls("r", [turn({ toolCallsUrl: "stored-blob-url" })], undefined, "attempt"), { wrapper: wrapper() });
    await waitFor(() => expect(first.result.current.allToolCalls).toHaveLength(1));
    expect(fetchArtifact).toHaveBeenCalledWith("/api/v1/requests/r/runs/attempt/tool-calls?iteration=1", "p1", expect.any(AbortSignal));
    expect(first.result.current.allToolCalls[0]).toMatchObject({ ...tool, _iteration: 1 });
    first.unmount();
    vi.mocked(fetchArtifact).mockImplementation(async () => new Response('{"name":42}\n'));
    const second = renderHook(() => useAllTurnsToolCalls("r2", [turn({ toolCallsUrl: "blob" })]), { wrapper: wrapper() });
    await waitFor(() => expect(second.result.current.error?.message).toContain("invalid tool-call"));
    expect(second.result.current.allToolCalls).toEqual([]);
  });
});
