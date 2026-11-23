// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ArtifactError, artifactUrl, fetchArtifact } from "./artifact-delivery";

const responseHeaders = ["content-type", "content-range", "content-length", "accept-ranges", "content-disposition"];

async function mediaWorker(signal: AbortSignal): Promise<ServiceWorker> {
  if (!window.isSecureContext || !("serviceWorker" in navigator) ||
      typeof MessageChannel !== "function" || typeof ReadableStream !== "function" ||
      typeof AbortSignal.any !== "function" || typeof crypto.randomUUID !== "function") {
    throw new Error("Authenticated video requires a secure browser with service-worker support.");
  }
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  const script = new URL("scope-media-worker.js", base).href;
  return new Promise((resolve, reject) => {
    let settled = false;
    let registered = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      if (error) reject(error);
      else resolve(navigator.serviceWorker.controller!);
    };
    const aborted = () => finish(new DOMException("Video session canceled.", "AbortError"));
    const changed = () => {
      if (!registered) return;
      const controller = navigator.serviceWorker.controller;
      if (controller?.scriptURL === script) finish();
      else if (controller) finish(new Error("An incompatible service worker controls this page."));
    };
    const timer = setTimeout(() => finish(new Error("Video delivery could not acquire this page. Reload and reopen the recording.")), 10_000);
    signal.addEventListener("abort", aborted, { once: true });
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    if (signal.aborted) aborted();
    else void (async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      if (settled) return;
      if ((navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL !== script) ||
          registrations.some(registration =>
        base.href.startsWith(registration.scope) &&
        [registration.active, registration.waiting, registration.installing]
          .some(worker => worker && worker.scriptURL !== script),
      )) throw new Error("Another service worker controls this app. Authenticated video cannot replace it.");
      await navigator.serviceWorker.register(script, { scope: base.pathname, updateViaCache: "none" });
      registered = true;
      if (!settled) changed();
    })().catch((cause: unknown) => finish(cause instanceof Error ? cause : new Error("Video worker registration failed.")));
  });
}

function videoHeaders(response: Response, range: unknown): string[][] {
  const length = response.headers.get("content-length");
  const size = length !== null && /^\d+$/.test(length) ? Number(length) : NaN;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  if (![200, 206].includes(response.status) || !Number.isSafeInteger(size) || size < 0 ||
      response.headers.get("accept-ranges") !== "bytes" ||
      (range !== null && response.status !== 206) ||
      (response.status === 206 && (range === null || !match || !match.slice(1).every(value => Number.isSafeInteger(Number(value))) ||
        Number(match[1]) > Number(match[2]) || Number(match[2]) >= Number(match[3]) ||
        Number(match[2]) - Number(match[1]) + 1 !== size))) {
    throw new Error("The server returned invalid progressive video headers.");
  }
  if (typeof range === "string" && match) {
    const requested = /^bytes=(\d*)-(\d*)$/.exec(range)!;
    const total = Number(match[3]);
    const start = requested[1] ? Number(requested[1]) : Math.max(0, total - Number(requested[2]));
    const end = requested[1] ? Math.min(requested[2] ? Number(requested[2]) : total - 1, total - 1) : total - 1;
    if (Number(match[1]) !== start || Number(match[2]) !== end) {
      throw new Error("The server returned a different video range than requested.");
    }
  }
  return responseHeaders.flatMap(key => {
    const value = response.headers.get(key);
    return value === null ? [] : [[key, value]];
  });
}

export interface MediaBridge {
  url: string;
  close(): void;
}

export async function openAuthenticatedMedia(
  path: string, projectId: string, signal: AbortSignal, onError: (message: string) => void,
): Promise<MediaBridge> {
  const canonical = artifactUrl(path, projectId);
  if (!canonical.pathname.endsWith("/video")) throw new Error("The media bridge only serves Scope video routes.");
  const worker = await mediaWorker(signal);
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  const requests = new Set<AbortController>();
  let closed = false;
  let rejectOpen: ((reason: Error) => void) | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(openTimer);
    rejectOpen?.(new DOMException("Video session canceled.", "AbortError"));
    rejectOpen = undefined;
    for (const controller of requests) controller.abort();
    channel.port1.postMessage({ type: "close" });
    channel.port1.close();
    signal.removeEventListener("abort", close);
    window.removeEventListener("pagehide", close);
    navigator.serviceWorker.removeEventListener("controllerchange", replaced);
  };
  const fail = (message: string) => {
    rejectOpen?.(new Error(message));
    rejectOpen = undefined;
    try { if (!signal.aborted && !closed) onError(message); }
    finally { close(); }
  };
  const replaced = () => fail("Video delivery restarted. Reopen the recording.");
  signal.addEventListener("abort", close, { once: true });
  window.addEventListener("pagehide", close);
  navigator.serviceWorker.addEventListener("controllerchange", replaced);

  async function serve(port: MessagePort, range: unknown) {
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    requests.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      controller.abort();
      requests.delete(controller);
      port.close();
    };
    const canceled = () => {
      // Cancel pending reads as well as fetch; no stale reader may outlive its session.
      void reader?.cancel().catch(() => { /* The fetch may already have aborted. */ });
      finish();
    };
    requestSignal.addEventListener("abort", canceled, { once: true });
    const error = (cause: unknown) => {
      if (!closed && !requestSignal.aborted) {
        const headers = cause instanceof ArtifactError ? cause.headers : undefined;
        port.postMessage({
          type: "error", status: cause instanceof ArtifactError ? cause.status : 503,
          message: cause instanceof Error ? cause.message : "Video stream failed.",
          headers: ["content-range", "accept-ranges"].flatMap(key => {
            const value = headers?.get(key);
            return value == null ? [] : [[key, value]];
          }),
        });
      }
      finish();
    };
    port.onmessageerror = () => error(new Error("Video stream connection failed."));
    port.onmessage = async event => {
      const data: unknown = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) {
        error(new Error("Invalid video stream request."));
        return;
      }
      if (data.type === "cancel") { finish(); return; }
      if (data.type !== "pull" || reading || !reader) {
        error(new Error("Invalid video stream request."));
        return;
      }
      if (requestSignal.aborted) return;
      reading = true;
      try {
        const chunk = await reader.read();
        requestSignal.throwIfAborted();
        if (chunk.done) { port.postMessage({ type: "end" }); finish(); }
        else port.postMessage({ type: "chunk", bytes: chunk.value });
      } catch (cause) {
        error(cause);
      } finally { reading = false; }
    };
    try {
      if (closed || requestSignal.aborted) throw new DOMException("Video closed.", "AbortError");
      if (range !== null && (typeof range !== "string" || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) {
        throw new ArtifactError("Unsupported video range.", 416);
      }
      const response = await fetchArtifact(canonical.href, projectId, requestSignal, range ?? undefined);
      requestSignal.throwIfAborted();
      if (!response.body) throw new Error("No video stream was returned.");
      reader = response.body.getReader();
      const headers = videoHeaders(response, range);
      port.postMessage({
        type: "headers", status: response.status, headers,
      });
    } catch (cause) {
      error(cause);
    }
  }

  await new Promise<void>((resolve, reject) => {
    if (closed || signal.aborted) { close(); reject(new DOMException("Video canceled.", "AbortError")); return; }
    rejectOpen = reject;
    openTimer = setTimeout(() => { reject(new Error("Video bridge did not respond.")); close(); }, 10_000);
    channel.port1.onmessageerror = () => fail("Video bridge connection failed.");
    channel.port1.onmessage = event => {
      const data: unknown = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) { fail("Invalid video bridge message."); return; }
      if (data.type === "ready") {
        clearTimeout(openTimer);
        rejectOpen = undefined;
        resolve();
      } else if (data.type === "fetch" && "range" in data && event.ports[0]) {
        if (closed || requests.size >= 4) {
          event.ports[0].postMessage({ type: "error", status: 429, message: "Too many concurrent video ranges." });
          event.ports[0].close();
        } else void serve(event.ports[0], data.range);
      } else if (data.type === "failed" && "message" in data && typeof data.message === "string") {
        fail(data.message);
      } else if (data.type === "closed" && "message" in data && typeof data.message === "string") {
        rejectOpen?.(new Error(data.message));
        fail(data.message);
      } else fail("Invalid video bridge message.");
    };
    try { worker.postMessage({ type: "scope-media-open", id }, [channel.port2]); }
    catch (cause) { close(); reject(cause); }
  });
  signal.throwIfAborted();
  return { url: new URL(`__scope_media__/${id}`, new URL(import.meta.env.BASE_URL, window.location.origin)).href, close };
}
