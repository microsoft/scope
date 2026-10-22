// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { MessageChannel as NativeMessageChannel, type MessagePort as NativePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAuthenticatedMedia } from "./authenticated-media";
import { resetApiClient, setApiSessionSignal, setApiTokenProvider, setReauthHandler } from "./api-client";

const script = readFileSync(new URL("../../public/scope-media-worker.js", import.meta.url), "utf8");
const origin = "https://scope.test";
const path = "/api/v1/requests/request-1/runs/attempt-1/video?iteration=2&index=1";
const channels: NativeMessageChannel[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
const sessions: AbortController[] = [];
class TestChannel extends NativeMessageChannel {
  constructor() { super(); channels.push(this); }
}

function onMessage(port: NativePort, listener: (event: MessageEvent<{ type: string }>) => void) {
  port.addEventListener("message", event => listener(event as MessageEvent<{ type: string }>));
  port.start();
}

function worker(scope = `${origin}/`) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const clients = new Map([["tab-1", { id: "tab-1", url: `${scope}runs/1`, type: "window" }]]);
  const context = {
    location: new URL(scope),
    registration: { scope },
    clients: { get: vi.fn(async (id: string) => clients.get(id)), claim: vi.fn() },
    skipWaiting: vi.fn(),
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) { handlers.set(type, listener); },
  };
  runInNewContext(script, {
    self: context, MessageChannel: TestChannel, URL, Headers, Response, ReadableStream, Uint8Array,
    setTimeout(callback: () => void, ms: number) {
      const timer = setTimeout(callback, ms); timers.add(timer); return timer;
    },
    clearTimeout,
  });
  return {
    context,
    clients,
    open(id: string, port: NativePort, clientId = "tab-1", url = `${scope}runs/1`) {
      handlers.get("message")!({
        data: { type: "scope-media-open", id }, ports: [port],
        source: { id: clientId, url, type: "window" },
      });
    },
    fetch(url: string, range: string | null = "bytes=0-3", clientId = "tab-1", signal?: AbortSignal, method = "GET") {
      let response: Promise<Response> | undefined;
      handlers.get("fetch")!({
        request: new Request(url, { method, headers: range ? { Range: range } : {}, signal }),
        clientId,
        respondWith(value: Response | Promise<Response>) { response = Promise.resolve(value); },
      });
      if (!response) throw new Error("Request was not intercepted.");
      return response;
    },
  };
}

function environment(scope = `${origin}/`) {
  const sw = worker(scope);
  const container = Object.assign(new EventTarget(), {
    controller: {
      scriptURL: `${scope}scope-media-worker.js`,
      postMessage: vi.fn((data: { id: string }, ports: NativePort[]) => sw.open(data.id, ports[0])),
    },
    getRegistrations: vi.fn(async () => [] as Array<{
      scope: string; active: { scriptURL: string }; waiting?: { scriptURL: string };
    }>),
    register: vi.fn(async () => ({})),
  });
  const page = Object.assign(new EventTarget(), { isSecureContext: true, location: new URL(scope) });
  vi.stubGlobal("window", page);
  vi.stubGlobal("navigator", { serviceWorker: container });
  vi.stubGlobal("MessageChannel", TestChannel);
  return { sw, container, page };
}

function session() {
  const controller = new AbortController();
  sessions.push(controller);
  return controller;
}

function recording(body: BodyInit | ReadableStream<Uint8Array> = new Uint8Array([1, 2, 3, 4]), range = "bytes 0-3/10") {
  return new Response(body, { status: 206, headers: {
    "Content-Type": "video/webm", "Content-Length": "4", "Content-Range": range, "Accept-Ranges": "bytes",
  } });
}

beforeEach(() => resetApiClient());
afterEach(() => {
  for (const controller of sessions.splice(0)) controller.abort();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const channel of channels.splice(0)) { channel.port1.close(); channel.port2.close(); }
  resetApiClient();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("production page + native worker protocol + shared API transport", () => {
  it("derives script, scope and bridge routing from the configured base path", async () => {
    vi.stubEnv("BASE_URL", "/scope/");
    const { sw, container } = environment(`${origin}/scope/`);
    vi.stubGlobal("fetch", vi.fn(async () => recording()));
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    expect(container.register).toHaveBeenCalledWith(`${origin}/scope/scope-media-worker.js`, {
      scope: "/scope/", updateViaCache: "none",
    });
    expect(bridge.url).toContain(`${origin}/scope/__scope_media__/`);
    expect((await sw.fetch(bridge.url)).status).toBe(206);
    bridge.close();
  });

  it("streams an initial non-range 200 without changing its bytes or length", async () => {
    const { sw } = environment();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "video/webm", "Content-Length": "3", "Accept-Ranges": "bytes" },
    })));
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    const response = await sw.fetch(bridge.url, null);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    bridge.close();
  });

  it.each(["bytes=6-", "bytes=-4", "bytes=6-999"])("preserves the bounded response for %s", async range => {
    const { sw } = environment();
    vi.stubGlobal("fetch", vi.fn(async () => recording(new Uint8Array([6, 7, 8, 9]), "bytes 6-9/10")));
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    const response = await sw.fetch(bridge.url, range);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 6-9/10");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([6, 7, 8, 9]);
    bridge.close();
  });

  it("authenticates initial and subsequent ranges with exact 206 bytes and no URL credentials or cache", async () => {
    const { sw } = environment();
    setApiTokenProvider(() => "test-only-idp");
    const fetcher = vi.fn(async () => recording());
    vi.stubGlobal("fetch", fetcher);
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    for (const range of ["bytes=0-3", "bytes=4-7"]) {
      fetcher.mockImplementation(async () => recording(new Uint8Array([1, 2, 3, 4]),
        range === "bytes=0-3" ? "bytes 0-3/10" : "bytes 4-7/10"));
      const response = await sw.fetch(bridge.url, range);
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(range === "bytes=0-3" ? "bytes 0-3/10" : "bytes 4-7/10");
      expect(response.headers.get("content-length")).toBe("4");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    }
    const calls = fetcher.mock.calls as unknown as [Request][];
    expect(calls).toHaveLength(2);
    expect(calls.map(([request]) => request.headers.get("range"))).toEqual(["bytes=0-3", "bytes=4-7"]);
    for (const [request] of calls) {
      expect(request.headers.get("authorization")).toBe("Bearer test-only-idp");
      expect(request.url).toBe(`${origin}${path}&projectId=project-1`);
      expect(request.credentials).toBe("omit");
      expect(request.cache).toBe("no-store");
      expect(request.redirect).toBe("error");
    }
    expect(bridge.url).toMatch(/^https:\/\/scope.test\/__scope_media__\/[a-f0-9-]{36}$/);
    expect(script).not.toMatch(/caches\.|indexedDB|localStorage|authorization|Bearer/);
    bridge.close();
  });

  it("does not drain the recording before native consumption and cancels old seek readers without closing the session", async () => {
    const { sw } = environment();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new Uint8Array([7])));
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => recording(source)));
    const error = vi.fn();
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, error);
    const response = await sw.fetch(bridge.url, "bytes=0-3");
    // ky's single response hook tees the response, allowing a bounded transport prefetch.
    expect(pull.mock.calls.length).toBeLessThanOrEqual(2);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([7]));
    expect(pull.mock.calls.length).toBeLessThan(4);
    await reader.cancel();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(error).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => recording()));
    expect((await sw.fetch(bridge.url, "bytes=0-3")).status).toBe(206);
    bridge.close();
  });

  it("serializes concurrent native reads while the upstream chunk is still pending", async () => {
    const { sw } = environment();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let canceled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) { upstream = controller; },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => recording(source)));
    const error = vi.fn();
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, error);
    const response = await sw.fetch(bridge.url);
    const reader = response.body!.getReader();
    const reads = [reader.read(), reader.read(), reader.read(), reader.read(), reader.read()];
    const completion = Promise.allSettled(reads);
    for (const value of [1, 2, 3, 4]) {
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      if (canceled) break;
      upstream.enqueue(new Uint8Array([value]));
    }
    if (!canceled) upstream.close();
    expect(await completion).toEqual([
      ...[1, 2, 3, 4].map(value => ({
        status: "fulfilled", value: { value: new Uint8Array([value]), done: false },
      })),
      { status: "fulfilled", value: { value: undefined, done: true } },
    ]);
    expect(error).not.toHaveBeenCalled();
    bridge.close();
  });

  it("uses the shared single 401 refresh for a range", async () => {
    const { sw } = environment();
    const token = vi.fn().mockResolvedValueOnce("expired").mockResolvedValueOnce("renewed");
    const reauth = vi.fn();
    setApiTokenProvider(token);
    setReauthHandler(reauth);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(recording());
    vi.stubGlobal("fetch", fetcher);
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    expect((await sw.fetch(bridge.url, "bytes=0-3")).status).toBe(206);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(token).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(reauth).not.toHaveBeenCalled();
    bridge.close();
  });

  it("stops after one refresh on permanent 401 and reports the failure", async () => {
    const { sw } = environment();
    const token = vi.fn(() => "test-only-token");
    const reauth = vi.fn();
    setApiTokenProvider(token);
    setReauthHandler(reauth);
    const fetcher = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const error = vi.fn();
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, error);
    expect((await sw.fetch(bridge.url)).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(token).toHaveBeenCalledTimes(2);
    expect(reauth).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("401")));
  });

  it.each([403, 404, 416])("preserves HTTP %s rather than racing it with session teardown", async status => {
    const { sw } = environment();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"Recording denied"}', {
      status, headers: { "Content-Type": "application/json", "Content-Range": "bytes */10", "Accept-Ranges": "bytes" },
    })));
    const error = vi.fn();
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, error);
    const response = await sw.fetch(bridge.url);
    expect(response.status).toBe(status);
    expect(await response.text()).toContain("Recording denied");
    if (status === 416) expect(response.headers.get("content-range")).toBe("bytes */10");
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("Recording denied")));
  });

  it("reauthorizes after membership loss; the bridge id is not an authorization cache", async () => {
    const { sw } = environment();
    const fetcher = vi.fn().mockResolvedValueOnce(recording()).mockResolvedValueOnce(
      new Response('{"error":"Membership removed"}', { status: 403, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    expect((await sw.fetch(bridge.url)).status).toBe(206);
    expect((await sw.fetch(bridge.url, "bytes=4-7")).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["account/logout/project/attempt signal", "pagehide", "worker replacement"])("cleans pending body reads on %s", async reason => {
    const { sw, page, container } = environment();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => recording(source)));
    const controller = session();
    setApiSessionSignal(controller.signal);
    const bridge = await openAuthenticatedMedia(path, "project-1", controller.signal, vi.fn());
    const response = await sw.fetch(bridge.url);
    const read = response.body!.getReader().read();
    const rejection = expect(read).rejects.toThrow();
    if (reason === "pagehide") page.dispatchEvent(new Event("pagehide"));
    else if (reason === "worker replacement") container.dispatchEvent(new Event("controllerchange"));
    else controller.abort();
    await rejection;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect((await sw.fetch(bridge.url)).status).toBe(403);
  });

  it("rejects other clients and loses routing on a worker restart without fetching protected data", async () => {
    const { sw } = environment();
    const fetcher = vi.fn(async () => recording());
    vi.stubGlobal("fetch", fetcher);
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    expect((await sw.fetch(bridge.url, null, "other-tab")).status).toBe(403);
    expect((await sw.fetch(bridge.url, null, "")).status).toBe(403);
    expect((await worker().fetch(bridge.url)).status).toBe(403);
    expect((await sw.fetch(`${bridge.url}?token=not-allowed`)).status).toBe(404);
    expect((await sw.fetch(bridge.url, null, "tab-1", undefined, "POST")).status).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails clearly on insecure/unsupported browsers and does not overwrite incompatible workers", async () => {
    const { page, container } = environment();
    page.isSecureContext = false;
    await expect(openAuthenticatedMedia(path, "project-1", session().signal, vi.fn())).rejects.toThrow("secure browser");
    page.isSecureContext = true;
    container.getRegistrations.mockResolvedValue([{
      scope: `${origin}/`, active: { scriptURL: `${origin}/scope-media-worker.js` },
      waiting: { scriptURL: `${origin}/mockServiceWorker.js` },
    }]);
    await expect(openAuthenticatedMedia(path, "project-1", session().signal, vi.fn())).rejects.toThrow("cannot replace");
    expect(container.register).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", {});
    await expect(openAuthenticatedMedia(path, "project-1", session().signal, vi.fn())).rejects.toThrow("secure browser");
  });

  it("settles and closes a bridge canceled before the worker acknowledges", async () => {
    const { container } = environment();
    container.controller.postMessage.mockImplementation(() => {});
    const controller = session();
    const opening = openAuthenticatedMedia(path, "project-1", controller.signal, vi.fn());
    const rejected = expect(opening).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(container.controller.postMessage).toHaveBeenCalled());
    controller.abort();
    await rejected;
  });

  it("settles a malformed opening response immediately and leaves no routing", async () => {
    const { container, sw } = environment();
    container.controller.postMessage.mockImplementation((_data, ports) => ports[0].postMessage(null));
    await expect(openAuthenticatedMedia(path, "project-1", session().signal, vi.fn())).rejects.toThrow("Invalid video bridge");
    expect((await sw.fetch(`${origin}/__scope_media__/12345678-1234-1234-1234-123456789abc`)).status).toBe(403);
  });

  it("times out acquisition without registering after a late registration inventory", async () => {
    vi.useFakeTimers();
    const { container } = environment();
    let complete!: (value: []) => void;
    container.getRegistrations.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const opening = openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    const rejection = expect(opening).rejects.toThrow("could not acquire");
    await vi.advanceTimersByTimeAsync(10_001);
    await rejection;
    complete([]);
    await Promise.resolve();
    expect(container.register).not.toHaveBeenCalled();
  });

  it("fails when the worker does not acknowledge instead of hanging", async () => {
    vi.useFakeTimers();
    const { container } = environment();
    container.controller.postMessage.mockImplementation(() => {});
    const opening = openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    const rejected = expect(opening).rejects.toThrow("did not respond");
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
  });

  it("rejects incorrect progressive headers and cancels the returned body", async () => {
    const { sw } = environment();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      status: 206, headers: { "Content-Type": "video/webm", "Content-Length": "4", "Content-Range": "bytes 0-8/10", "Accept-Ranges": "bytes" },
    })));
    const error = vi.fn();
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, error);
    expect((await sw.fetch(bridge.url)).status).toBe(503);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it("rejects a well-formed but different response range", async () => {
    const { sw } = environment();
    vi.stubGlobal("fetch", vi.fn(async () => recording()));
    const error = vi.fn();
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, error);
    expect((await sw.fetch(bridge.url, "bytes=4-7")).status).toBe(503);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("different video range")));
  });

  it("aborts establishment when the worker range timeout cancels the page request", async () => {
    vi.useFakeTimers();
    const { sw } = environment();
    let upstream: Request | undefined;
    vi.stubGlobal("fetch", vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
      upstream = request;
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    })));
    const bridge = await openAuthenticatedMedia(path, "project-1", session().signal, vi.fn());
    const response = sw.fetch(bridge.url);
    await vi.waitFor(() => expect(upstream).toBeDefined());
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await response).status).toBe(503);
    await vi.waitFor(() => expect(upstream?.signal.aborted).toBe(true));
  });
});

describe("executable service-worker protocol defenses", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  async function opened() {
    const sw = worker();
    const channel = new TestChannel();
    const ready = new Promise(resolve => { onMessage(channel.port1, resolve); });
    sw.open(id, channel.port2);
    await ready;
    return { sw, port: channel.port1, url: `${origin}/__scope_media__/${id}` };
  }

  it.each([
    { type: "headers", status: 206, headers: [["Set-Cookie", "bad"]] },
    { type: "headers", status: 206, headers: [["content-length", "\r\ninvalid"]] },
    { type: "headers", status: 206, headers: [["content-length", "not-a-number"]] },
    { type: "error", status: 416, headers: [["content-range", "bytes */10\r\ninvalid"]] },
    { type: "chunk", bytes: new Uint8Array([1]) },
    { type: "nonsense" },
  ])("rejects malformed/unordered messages: $type", async message => {
    const { sw, port, url } = await opened();
    onMessage(port, event => {
      if (event.data.type === "fetch") event.ports[0].postMessage(message);
    });
    expect((await sw.fetch(url)).status).toBe(503);
  });

  it("limits simultaneous ranges and times out unresponsive page fetches", async () => {
    vi.useFakeTimers();
    const { sw, url } = await opened();
    const pending = Array.from({ length: 4 }, () => sw.fetch(url));
    expect((await sw.fetch(url)).status).toBe(429);
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await Promise.all(pending)).map(response => response.status)).toEqual([503, 503, 503, 503]);
  });

  it("never requests bytes until the native reader pulls, then rejects truncated bodies", async () => {
    const { sw, port, url } = await opened();
    const pulls = vi.fn();
    onMessage(port, event => {
      if (event.data.type !== "fetch") return;
      const transfer = event.ports[0];
      transfer.onmessage = () => { pulls(); transfer.postMessage({ type: "end" }); };
      transfer.postMessage({ type: "headers", status: 206, headers: [
        ["content-length", "4"], ["content-range", "bytes 0-3/10"], ["content-type", "video/webm"],
      ] });
    });
    const response = await sw.fetch(url);
    expect(pulls).not.toHaveBeenCalled();
    await expect(response.body!.getReader().read()).rejects.toThrow("Invalid video stream");
    expect(pulls).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized chunk rather than forwarding extra bytes", async () => {
    const { sw, port, url } = await opened();
    onMessage(port, event => {
      if (event.data.type !== "fetch") return;
      const transfer = event.ports[0];
      transfer.onmessage = () => transfer.postMessage({ type: "chunk", bytes: new Uint8Array(5) });
      transfer.postMessage({ type: "headers", status: 206, headers: [["content-length", "4"]] });
    });
    const response = await sw.fetch(url);
    await expect(response.body!.getReader().read()).rejects.toThrow("Invalid video stream");
  });

  it("expires idle sessions without persistent routing", async () => {
    vi.useFakeTimers();
    const { sw, url } = await opened();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect((await sw.fetch(url)).status).toBe(403);
  });

  it("rejects cross-origin or out-of-scope pages and clients gone during lookup", async () => {
    const sw = worker(`${origin}/scope/`);
    const channel = new TestChannel();
    sw.open(id, channel.port2, "tab-1", "https://foreign.test/scope/");
    expect((await sw.fetch(`${origin}/scope/__scope_media__/${id}`)).status).toBe(403);
    sw.open(id, channel.port2, "tab-1", `${origin}/outside/`);
    expect((await sw.fetch(`${origin}/scope/__scope_media__/${id}`)).status).toBe(403);
    const ready = new Promise(resolve => { onMessage(channel.port1, resolve); });
    sw.open(id, channel.port2, "tab-1", `${origin}/scope/`);
    await ready;
    sw.clients.clear();
    expect((await sw.fetch(`${origin}/scope/__scope_media__/${id}`)).status).toBe(410);
  });

  it("uses the registration base path and bypasses unrelated origin/routes", async () => {
    const sw = worker(`${origin}/scope/`);
    expect(() => sw.fetch(`${origin}/api/v1/requests/1/video`)).toThrow("not intercepted");
    expect(() => sw.fetch(`https://foreign.test/scope/__scope_media__/${id}`)).toThrow("not intercepted");
    expect((await sw.fetch(`${origin}/scope/__scope_media__/invalid`)).status).toBe(404);
  });
});
