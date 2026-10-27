// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { apiClient } from "./api-client";
import { isNetworkError } from "ky";

const requestArtifact = /^\/api\/v1\/requests\/[a-zA-Z0-9_-]+(?:\/runs\/[a-zA-Z0-9_-]+)?\/(?:archive|har|atif|tool-calls|video|snapshots\/[1-9]\d*)$/;
const codebaseArchive = /^\/api\/v1\/codebase-revisions\/[a-zA-Z0-9_-]+\/archive$/;
const queryKeys = new Set(["projectId", "iteration", "index", "phase"]);

/** Never attach the Portal's bearer to a stored blob URL or a redirect. */
export function artifactUrl(path: string, projectId: string): URL {
  const url = new URL(path, window.location.href);
  if (!projectId || url.origin !== window.location.origin || url.username || url.password ||
      url.hash || (!requestArtifact.test(url.pathname) && !codebaseArchive.test(url.pathname)) ||
      [...url.searchParams.keys()].some(key => !queryKeys.has(key)) ||
      (url.searchParams.has("projectId") && url.searchParams.get("projectId") !== projectId)) {
    throw new Error("Only project-bound, same-origin Scope artifact routes are allowed.");
  }
  for (const key of queryKeys) {
    if (url.searchParams.getAll(key).length > 1) throw new Error("Duplicate artifact query parameter.");
  }
  for (const key of ["iteration", "index"]) {
    const value = url.searchParams.get(key);
    if (value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
        Number(value) < (key === "index" ? 0 : 1))) {
      throw new Error(`Invalid artifact ${key}.`);
    }
  }
  if (url.searchParams.has("phase") && url.searchParams.get("phase") !== "setup") {
    throw new Error("Invalid artifact phase.");
  }
  url.searchParams.set("projectId", projectId);
  return url;
}

export class ArtifactError extends Error {
  constructor(message: string, public readonly status: number, public readonly headers?: Headers) {
    super(message);
    this.name = "ArtifactError";
  }
}

async function responseError(response: Response): Promise<ArtifactError> {
  let message = `Artifact request failed (HTTP ${response.status}).`;
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        message = `${message} ${body.error.slice(0, 300)}`;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      message += " The server returned an invalid error response.";
    }
  } else {
    await response.body?.cancel();
  }
  return new ArtifactError(message, response.status, new Headers(response.headers));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Retry only establishment; an accepted body's failures must not restart bytes. */
export async function fetchArtifact(
  path: string, projectId: string, signal: AbortSignal, range?: string,
): Promise<Response> {
  const url = artifactUrl(path, projectId);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await apiClient(url, {
        signal, redirect: "error", credentials: "omit", cache: "no-store",
        headers: range ? { Range: range } : undefined,
      });
    } catch (error) {
      if (signal.aborted || attempt >= 2 || !isNetworkError(error)) throw error;
      await delay(250 * 2 ** attempt, signal);
      continue;
    }
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
      const retryAfter = response.headers.get("retry-after");
      const wait = retryAfter === null ? 250 * 2 ** attempt
        : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
        : Math.max(0, Date.parse(retryAfter) - Date.now());
      if (Number.isFinite(wait) && wait <= 5000) {
        await response.body?.cancel();
        await delay(wait, signal);
        continue;
      }
    }
    signal.throwIfAborted();
    if (!response.ok) throw await responseError(response);
    if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) {
      await response.body?.cancel();
      throw new Error("Artifact redirects are not allowed.");
    }
    if (response.status !== 200 && !(range && response.status === 206)) {
      await response.body?.cancel();
      throw new ArtifactError("The server returned an incomplete artifact response.", response.status);
    }
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const isVideo = url.pathname.endsWith("/video");
    const isArchive = /\/(?:archive|snapshots\/\d+)$/.test(url.pathname);
    if (!type || (isVideo ? !["video/webm", "video/mp4"].includes(type)
      : isArchive ? !["application/gzip", "application/x-gzip", "application/x-tar", "application/zip", "application/octet-stream"].includes(type)
      : !["application/json", "application/gzip", "application/octet-stream", "application/x-ndjson"].includes(type))) {
      await response.body?.cancel();
      throw new Error("The server did not return the expected artifact content type.");
    }
    return response;
  }
}

export function artifactFilename(disposition: string | null, fallback: string): string {
  const sanitize = (value: string) => value
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/^\.+/, "").trim().slice(0, 200).replace(/[. ]+$/, "");
  const safeFallback = sanitize(fallback) || "artifact";
  let name = disposition?.match(/filename="((?:\\.|[^"])*)"/i)?.[1]?.replace(/\\(.)/g, "$1")
    ?? disposition?.match(/filename=([^;]+)/i)?.[1]?.trim() ?? safeFallback;
  const encoded = disposition?.match(/filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i)?.[1]?.trim();
  if (encoded) {
    try { name = decodeURIComponent(encoded); }
    catch { throw new Error("The artifact has an invalid encoded filename."); }
  }
  return sanitize(name) || safeFallback;
}

/** Object URLs live only in this page, never in storage or the service worker. */
export async function downloadArtifact(
  path: string, projectId: string, signal: AbortSignal, fallback = "artifact",
): Promise<void> {
  const response = await fetchArtifact(path, projectId, signal);
  await saveArtifact(response, signal, fallback);
}

export async function downloadBatchArtifacts(ids: readonly string[], projectId: string, signal: AbortSignal): Promise<void> {
  if (!projectId || !ids.length || ids.some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error("Select project-bound requests to download.");
  }
  signal.throwIfAborted();
  const url = new URL("/api/v1/requests/archive", window.location.origin);
  url.searchParams.set("projectId", projectId);
  // A batch POST is never replayed on a network/5xx failure.
  const response = await apiClient(url, {
    method: "POST", signal, redirect: "error", credentials: "omit", cache: "no-store",
    json: { ids },
  });
  signal.throwIfAborted();
  if (!response.ok) throw await responseError(response);
  if (response.status !== 200 || response.redirected ||
      (response.url && new URL(response.url).href !== url.href) ||
      !["application/gzip", "application/x-gzip", "application/octet-stream"].includes(
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "",
      )) {
    await response.body?.cancel();
    throw new Error("The server did not return a batch archive.");
  }
  await saveArtifact(response, signal, `batch-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
}

async function saveArtifact(response: Response, signal: AbortSignal, fallback: string): Promise<void> {
  let filename: string;
  try {
    filename = artifactFilename(response.headers.get("content-disposition"), fallback);
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
  signal.throwIfAborted();
  const chunks: BlobPart[] = [];
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The artifact response has no body.");
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      chunks.push(new Uint8Array(value));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      if (signal.aborted) await reader.cancel(signal.reason);
    } finally {
      reader.releaseLock();
    }
  }
  const blob = new Blob(chunks, { type: response.headers.get("content-type") ?? "application/octet-stream" });
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    clearTimeout(timer);
    URL.revokeObjectURL(url);
    signal.removeEventListener("abort", revoke);
    window.removeEventListener("pagehide", revoke);
    anchor.remove();
  };
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  signal.addEventListener("abort", revoke, { once: true });
  window.addEventListener("pagehide", revoke, { once: true });
  timer = setTimeout(revoke, 60_000);
  try {
    anchor.click();
  } catch (error) {
    revoke();
    throw error;
  } finally {
    anchor.remove();
  }
}
