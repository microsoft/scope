// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openLogStream, readLogStream, type LogStreamEvent } from "./log-stream";
import { resetApiClient, setApiTokenProvider, setReauthHandler } from "./api-client";

const url = "https://scope.test/api/v1/requests/run/logs?fromStart=true";
const log = { timestamp: "2026-05-01T00:00:00.000Z", level: "info", message: "hello 🦊 世界" };
const encoder = new TextEncoder();
let fetchMock: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;
function response(text: string) {
  return new Response(text, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
async function parse(text: string, byteChunks = false) {
  const events: LogStreamEvent[] = [];
  const bytes = encoder.encode(text);
  const chunks = byteChunks ? Array.from(bytes, (byte) => new Uint8Array([byte])) : [bytes];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  await readLogStream(new Response(stream), new AbortController().signal, (event) => events.push(event));
  return events;
}

beforeEach(() => {
  resetApiClient();
  fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetApiClient();
});

describe("log SSE parser", () => {
  it.each([false, true])("parses UTF-8, CRLF, multiline data and heartbeats (byte chunks: %s)", async (chunks) => {
    const json = JSON.stringify(log).replace(',"message"', ',\r\ndata: "message"');
    const events = await parse(`: heartbeat\r\n\r\nevent: message\r\ndata: ${json}\r\n\r\ndata: {"type":"turns_summary","turns":2}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n`, chunks);
    expect(events).toEqual([{ type: "log", log }, { type: "done" }]);
  });
  it("supports CR-only frames, BOM and irrelevant named events", async () => {
    expect(await parse(`\uFEFFevent: other\rdata: not-json\r\revent: done\rdata: {}\r\r`))
      .toEqual([{ type: "done" }]);
  });
  it.each(["timeout", "error", "done"])("stops at a named %s event even with trailing chunks", async (type) => {
    const events = await parse(`event: ${type}\ndata: {"message":"storage unavailable"}\n\ndata: ${JSON.stringify(log)}\n\n`);
    expect(events).toEqual([type === "error"
      ? { type: "error", message: "storage unavailable" }
      : { type }]);
  });
  it.each([
    ["not-json", "Invalid JSON"],
    [JSON.stringify({ ...log, level: "arbitrary" }), "Invalid log entry"],
    [JSON.stringify({ ...log, timestamp: "invalid" }), "Invalid log entry"],
    [JSON.stringify({ ...log, data: [] }), "Invalid log entry"],
    [JSON.stringify({ ...log, source: 12 }), "Invalid log entry"],
  ])("surfaces malformed log data %s", async (data, message) => {
    await expect(parse(`data: ${data}\n\n`)).rejects.toThrow(message);
  });
  it("does not turn an unterminated event at EOF into a completed replay", async () => {
    await expect(parse(`data: ${JSON.stringify(log)}\n`)).rejects.toThrow(/disconnected/);
  });
  it("rejects malformed named errors instead of disguising them as a connection error", async () => {
    await expect(parse("event: error\ndata: {}\n\n")).rejects.toThrow("Invalid log stream error event");
  });
});

describe("authenticated stream establishment", () => {
  it("refreshes one initial 401 through the shared transport and returns a readable stream", async () => {
    const provider = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("fresh");
    const reauth = vi.fn();
    setApiTokenProvider(provider);
    setReauthHandler(reauth);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(response("event: done\ndata: {}\n\n"));
    const opened = await openLogStream(url, new AbortController().signal);
    await expect(readLogStream(opened, new AbortController().signal, vi.fn())).resolves.toBeUndefined();
    expect(provider).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetchMock.mock.calls.map(([request]: [Request]) => request.headers.get("Authorization")))
      .toEqual(["Bearer old", "Bearer fresh"]);
    expect(reauth).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([request]: [Request]) => request.url === url)).toBe(true);
  });
  it.each([403, 404, 409])("terminates HTTP %s without token refresh, retries or interactive login", async (status) => {
    const provider = vi.fn(() => "token");
    const reauth = vi.fn();
    setApiTokenProvider(provider);
    setReauthHandler(reauth);
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    await expect(openLogStream(url, new AbortController().signal)).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledOnce();
    expect(reauth).not.toHaveBeenCalled();
  });
  it("caps repeated 401 at the existing single refresh and single reauth callback", async () => {
    const reauth = vi.fn();
    setApiTokenProvider(() => "token");
    setReauthHandler(reauth);
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status: 401 })));
    await expect(openLogStream(url, new AbortController().signal)).rejects.toThrow("HTTP 401");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reauth).toHaveBeenCalledOnce();
  });
  it.each([429, 500, 502, 503, 504])("bounds transient HTTP %s retries and honors Retry-After", async (status) => {
    vi.useFakeTimers();
    const provider = vi.fn(() => "reacquired-token");
    setApiTokenProvider(provider);
    fetchMock.mockImplementation(() => Promise.resolve(new Response("", { status, headers: { "Retry-After": "1" } })));
    const opened = openLogStream(url, new AbortController().signal);
    const rejected = expect(opened).rejects.toThrow(`HTTP ${status}`);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(provider).toHaveBeenCalledTimes(3);
  });
  it("honors an HTTP-date Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "Fri, 01 May 2026 00:00:02 GMT" } }))
      .mockResolvedValueOnce(response("event: done\ndata: {}\n\n"));
    const opened = openLogStream(url, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await (await opened).body?.cancel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not retry early when Retry-After exceeds the bounded wait", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "3600" } }));
    await expect(openLogStream(url, new AbortController().signal)).rejects.toThrow("HTTP 429");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("reacquires the bearer after a network failure before any response", async () => {
    vi.useFakeTimers();
    const provider = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");
    setApiTokenProvider(provider);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(response("event: done\ndata: {}\n\n"));
    const opened = openLogStream(url, new AbortController().signal);
    await vi.runAllTimersAsync();
    await (await opened).body?.cancel();
    expect(fetchMock.mock.calls.map(([request]: [Request]) => request.headers.get("Authorization")))
      .toEqual(["Bearer first", "Bearer second"]);
  });
  it("aborts during backoff without sending another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    const opened = openLogStream(url, controller.signal);
    const rejected = expect(opened).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("rejects non-SSE successful responses instead of marking a login HTML page connected", async () => {
    fetchMock.mockResolvedValue(new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }));
    await expect(openLogStream(url, new AbortController().signal)).rejects.toThrow("Expected a text/event-stream");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
