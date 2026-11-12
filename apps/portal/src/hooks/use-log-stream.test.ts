// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiClient, setApiTokenProvider, setApiSessionSignal } from "@/lib/api-client";
import { useLogStream } from "./use-log-stream";

const scope = vi.hoisted(() => ({
  projectId: "project-a",
  auth: {
    isReady: true,
    user: { id: "alice" },
    account: { homeAccountId: "alice", localAccountId: "alice", tenantId: "tenant", environment: "local" },
  },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => scope.auth }));
vi.mock("@/contexts/ProjectContext", () => ({ useSelectedProjectId: () => scope.projectId }));
vi.mock("@/lib/api", () => ({
  api: { logsUrl: (id: string, fromStart: boolean) => `https://scope.test/api/v1/requests/${id}/logs?fromStart=${fromStart}` },
}));

const log = { timestamp: "2026-05-01T00:00:00.000Z", level: "info", message: "first attempt" };
const encoder = new TextEncoder();
let fetchMock: ReturnType<typeof vi.fn>;

function liveStream() {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
    cancel,
  }), { headers: { "Content-Type": "text/event-stream" } });
  return {
    response, cancel,
    send: (data: string) => source.enqueue(encoder.encode(data)),
    close: () => source.close(),
    fail: () => source.error(new TypeError("connection reset")),
  };
}

beforeEach(() => {
  resetApiClient();
  scope.projectId = "project-a";
  scope.auth.isReady = true;
  scope.auth.user.id = "alice";
  scope.auth.account.homeAccountId = "alice";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setApiTokenProvider(() => "test-token");
});
afterEach(() => {
  cleanup();
  resetApiClient();
  vi.unstubAllGlobals();
});

describe("useLogStream authenticated fetch integration", () => {
  it("uses bearer transport, preserves fromStart and handles live logs, clear and done", async () => {
    const stream = liveStream();
    fetchMock.mockResolvedValue(stream.response);
    const { result } = renderHook(() => useLogStream({ id: "request", fromStart: false }));
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    expect(request.url).toBe("https://scope.test/api/v1/requests/request/logs?fromStart=false&projectId=project-a");
    expect(request.url).not.toContain("test-token");
    await act(async () => stream.send(`data: ${JSON.stringify(log)}\n\n`));
    await waitFor(() => expect(result.current.logs).toEqual([log]));
    act(() => result.current.clear());
    expect(result.current.logs).toEqual([]);
    await act(async () => stream.send("event: done\ndata: {}\n\n"));
    await waitFor(() => expect(result.current.isDone).toBe(true));
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(stream.cancel).toHaveBeenCalled());
  });

  it.each(["attempt", "id", "project", "account", "scope-user", "logout", "disabled"] as const)(
    "clears and cancels the replaced %s stream, rejecting late queued logs",
    async (change) => {
      const first = liveStream();
      const second = liveStream();
      fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
      const { result, rerender } = renderHook(
        (props) => useLogStream(props),
        { initialProps: { id: "request", attemptNumber: 1, enabled: true } },
      );
      await waitFor(() => expect(result.current.isConnected).toBe(true));
      await act(async () => first.send(`data: ${JSON.stringify(log)}\n\n`));
      await waitFor(() => expect(result.current.logs).toHaveLength(1));
      const props = { id: "request", attemptNumber: 1, enabled: true };
      if (change === "attempt") props.attemptNumber = 2;
      if (change === "id") props.id = "other";
      if (change === "project") scope.projectId = "project-b";
      if (change === "account") scope.auth.account.homeAccountId = "bob";
      if (change === "scope-user") scope.auth.user.id = "bob";
      if (change === "logout") scope.auth.isReady = false;
      if (change === "disabled") props.enabled = false;
      act(() => {
        first.send(`data: ${JSON.stringify({ ...log, message: "late" })}\n\n`);
        rerender(props);
      });
      expect(result.current.logs).toEqual([]);
      expect(result.current.isDone).toBe(false);
      await waitFor(() => expect(first.cancel).toHaveBeenCalled());
      if (change === "logout" || change === "disabled") {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.isConnected).toBe(false);
      } else {
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(result.current.error).toBeNull();
      }
    },
  );

  it("aborts a pending fetch on unmount", async () => {
    fetchMock.mockImplementation((request: Request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason));
    }));
    const { unmount } = renderHook(() => useLogStream({ id: "request" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0][0] as Request;
    unmount();
    expect(request.signal.aborted).toBe(true);
  });

  it("does not open a stream before the Scope-user handshake is ready", () => {
    scope.auth.isReady = false;
    const { result } = renderHook(() => useLogStream({ id: "request" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.logs).toEqual([]);
  });

  it("does not fetch logs without a selected project", () => {
    scope.projectId = "";
    const { result } = renderHook(() => useLogStream({ id: "request" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.logs).toEqual([]);
  });

  it("binds a custom historical/report URL to the selected project without changing replay options", async () => {
    const stream = liveStream();
    fetchMock.mockResolvedValue(stream.response);
    const urlBuilder = vi.fn((id: string, fromStart: boolean) =>
      `https://scope.test/api/v1/reports/${id}/logs?fromStart=${fromStart}`);
    const { result } = renderHook(() => useLogStream({ id: "report", fromStart: true, urlBuilder }));
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(urlBuilder).toHaveBeenCalledWith("report", true);
    expect((fetchMock.mock.calls[0][0] as Request).url)
      .toBe("https://scope.test/api/v1/reports/report/logs?fromStart=true&projectId=project-a");
  });

  it.each(["timeout", "error"] as const)("surfaces a named server %s without marking success or reconnecting", async (type) => {
    const stream = liveStream();
    fetchMock.mockResolvedValue(stream.response);
    const { result } = renderHook(() => useLogStream({ id: "request" }));
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    await act(async () => stream.send(`event: ${type}\ndata: {"message":"blob storage unavailable"}\n\n`));
    await waitFor(() => expect(result.current.error).toBe(type === "timeout" ? "Stream timed out" : "blob storage unavailable"));
    expect(result.current.isDone).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not reconnect a closed authorization lease or duplicate received logs", async () => {
    const stream = liveStream();
    fetchMock.mockResolvedValue(stream.response);
    const { result } = renderHook(() => useLogStream({ id: "request" }));
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    await act(async () => stream.send(`data: ${JSON.stringify(log)}\n\n`));
    await waitFor(() => expect(result.current.logs).toHaveLength(1));
    await act(async () => stream.close());
    await waitFor(() => expect(result.current.error).toMatch(/disconnected.*Reload/));
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isDone).toBe(false);
    expect(result.current.logs).toEqual([log]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces network failure after connection without a replay loop", async () => {
    const stream = liveStream();
    fetchMock.mockResolvedValue(stream.response);
    const { result } = renderHook(() => useLogStream({ id: "request" }));
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    await act(async () => stream.fail());
    await waitFor(() => expect(result.current.error).toContain("connection reset"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("session cancellation closes an established fetch body", async () => {
    const session = new AbortController();
    setApiSessionSignal(session.signal);
    const stream = liveStream();
    fetchMock.mockImplementation((request: Request) => {
      // A real fetch cancels its body when its request signal aborts.
      request.signal.addEventListener("abort", () => stream.close());
      return stream.response;
    });
    const { result, rerender } = renderHook(() => useLogStream({ id: "request" }));
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    act(() => {
      session.abort();
      scope.auth.isReady = false;
      rerender();
    });
    expect(result.current.logs).toEqual([]);
    expect(result.current.isConnected).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
