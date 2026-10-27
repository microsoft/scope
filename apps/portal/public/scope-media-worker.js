// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* This worker holds only client-bound ports, never bearer tokens or cached bytes. */
const sessions = new Map();
const bridgePath = new URL("__scope_media__/", self.registration.scope).pathname;
const idleMs = 5 * 60 * 1000;
const responseHeaders = new Set(["content-type", "content-range", "content-length", "accept-ranges", "content-disposition"]);
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function closeSession(id, message) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(session.timer);
  for (const cancel of session.pending) cancel(message);
  session.port.postMessage({ type: "closed", message });
  session.port.close();
}

function touch(id, session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => closeSession(id, "Video session expired. Reopen the recording."), idleMs);
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.type !== "scope-media-open" || typeof data.id !== "string" || !validId.test(data.id) ||
      !event.source || event.source.type !== "window" || !event.ports[0]) return;
  const source = event.source;
  const sourceUrl = new URL(source.url);
  if (sourceUrl.origin !== self.location.origin || !sourceUrl.href.startsWith(self.registration.scope)) return;
  if (sessions.has(data.id)) return;
  const session = { clientId: source.id, port: event.ports[0], pending: new Set(), timer: null };
  sessions.set(data.id, session);
  session.port.onmessage = message => {
    if (message.data?.type === "close") closeSession(data.id, "Video session closed.");
  };
  session.port.onmessageerror = () => closeSession(data.id, "Video connection failed.");
  touch(data.id, session);
  session.port.postMessage({ type: "ready" });
});

function failure(status, message, forwarded = []) {
  const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "text/plain" });
  for (const [key, value] of forwarded) {
    if (["content-range", "accept-ranges"].includes(key.toLowerCase())) headers.set(key, value);
  }
  return new Response(message, { status, headers });
}

function validHeaders(headers) {
  return Array.isArray(headers) && headers.every(pair =>
    Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === "string") &&
    responseHeaders.has(pair[0].toLowerCase()));
}

async function mediaResponse(event, id) {
  const session = sessions.get(id);
  if (!session || !event.clientId || event.clientId !== session.clientId) {
    return failure(403, "This recording belongs to a different or expired browser client.");
  }
  if (event.request.method !== "GET") return failure(405, "Only video GET requests are allowed.");
  const client = await self.clients.get(session.clientId);
  if (!client || new URL(client.url).origin !== self.location.origin) {
    closeSession(id, "The originating page is no longer available.");
    return failure(410, "Video session closed.");
  }
  if (sessions.get(id) !== session) return failure(410, "Video session closed.");
  if (session.pending.size >= 4) return failure(429, "Too many concurrent video ranges.");
  touch(id, session);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let stream;
    let headersReceived = false;
    let finished = false;
    let awaitingChunk = false;
    let completePull;
    let remaining = 0;
    let timer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      session.pending.delete(cancel);
      event.request.signal.removeEventListener("abort", abort);
      channel.port1.close();
      settlePull();
    };
    const settlePull = () => {
      const complete = completePull;
      completePull = undefined;
      complete?.();
    };
    const cancel = (message, report = true) => {
      if (finished) return;
      channel.port1.postMessage({ type: "cancel" });
      if (headersReceived) stream?.error(new Error(message));
      else resolve(failure(503, message));
      finish();
      if (report) session.port.postMessage({ type: "failed", message });
    };
    const abort = () => cancel("Video range canceled.", false);
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cancel("Video range timed out."), 30_000);
    };
    session.pending.add(cancel);
    event.request.signal.addEventListener("abort", abort, { once: true });
    channel.port1.onmessageerror = () => cancel("Invalid video stream message.");
    channel.port1.onmessage = message => {
      if (finished) return;
      const data = message.data;
      if (data?.type === "headers" && !headersReceived) {
        if (![200, 206].includes(data.status) || !validHeaders(data.headers)) {
          cancel("Invalid video response.");
          return;
        }
        let headers;
        try { headers = new Headers(data.headers); }
        catch { cancel("Invalid video response headers."); return; }
        const length = headers.get("content-length");
        remaining = length !== null && /^\d+$/.test(length) ? Number(length) : NaN;
        if (!Number.isSafeInteger(remaining) || remaining < 0) {
          cancel("Invalid video response length.");
          return;
        }
        clearTimeout(timer);
        touch(id, session);
        headers.set("Cache-Control", "no-store");
        headersReceived = true;
        const body = new ReadableStream({
          start(controller) { stream = controller; },
          pull() {
            // Keep the Streams pull pending until its MessagePort round trip completes.
            return new Promise(resolvePull => {
              completePull = resolvePull;
              awaitingChunk = true;
              armTimeout();
              channel.port1.postMessage({ type: "pull" });
            });
          },
          cancel() { channel.port1.postMessage({ type: "cancel" }); finish(); },
        }, { highWaterMark: 0 });
        resolve(new Response(body, { status: data.status, headers }));
      } else if (data?.type === "chunk" && headersReceived && awaitingChunk &&
          data.bytes instanceof Uint8Array && data.bytes.byteLength > 0 && data.bytes.byteLength <= remaining) {
        clearTimeout(timer);
        touch(id, session);
        awaitingChunk = false;
        remaining -= data.bytes.byteLength;
        stream.enqueue(data.bytes);
        settlePull();
      } else if (data?.type === "end" && headersReceived && awaitingChunk && remaining === 0) {
        stream.close();
        finish();
      } else if (data?.type === "error") {
        const status = Number.isInteger(data.status) && data.status >= 400 && data.status <= 599 ? data.status : 503;
        const text = typeof data.message === "string" ? data.message : "Video delivery failed.";
        if (!validHeaders(data.headers ?? [])) { cancel("Invalid video error headers."); return; }
        let response;
        try { response = failure(status, text, data.headers); }
        catch { cancel("Invalid video error headers."); return; }
        if (headersReceived) stream.error(new Error(text));
        else resolve(response);
        finish();
        session.port.postMessage({ type: "failed", message: text });
      } else cancel("Invalid video stream message.");
    };
    armTimeout();
    if (event.request.signal.aborted) abort();
    else session.port.postMessage({ type: "fetch", range: event.request.headers.get("range") }, [channel.port2]);
  });
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(bridgePath)) return;
  const id = url.pathname.slice(bridgePath.length);
  event.respondWith(url.search || !validId.test(id)
    ? failure(404, "Invalid video bridge route.")
    : mediaResponse(event, id));
});
