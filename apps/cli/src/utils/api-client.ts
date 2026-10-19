// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Centralized Scope API HTTP client for the CLI.
 *
 * Every CLI request to the Scope API goes through {@link apiFetch}. It owns:
 *  - base-URL normalization (callers pass the raw `--url`/`SCOPE_API_URL` value
 *    plus a resource-relative path such as `/requests/...`; this module joins
 *    them onto the configurable API base path — {@link DEFAULT_API_BASE_PATH},
 *    default `/api/v1`, overridable via {@link setApiBasePath}),
 *  - `Authorization: Bearer` injection (today from the `SCOPE_TOKEN` raw-bearer
 *    escape hatch; a pluggable {@link setTokenProvider} seam lets CLI auth —
 *    auth-rbac.md subtask 8 — supply tokens from the SecretStore later),
 *  - `401` → re-auth handling via a pluggable {@link setReauthHandler} seam,
 *  - error shaping ({@link ApiError} + {@link readApiError}),
 *  - a pluggable logging sink ({@link setApiLogSink}) with **mandatory secret
 *    redaction** — the foundation for the `--debug-zip` support package
 *    (subtask 9).
 *
 * Internally it is built on [`ky`](https://github.com/sindresorhus/ky): a single
 * cached `ky` instance is the transport, configured with `throwHttpErrors: false`
 * (call sites keep their own `response.ok` handling), `timeout: false`, and
 * `retry: 0`. Auth is injected by a `ky` `beforeRequest` hook; the `401` re-auth
 * retry and the logging sink stay in this facade. `ky` ultimately calls the global
 * `fetch`, so tests can keep stubbing `fetch` (note: `ky` invokes it with a
 * `Request` object, not a URL string).
 *
 * See [docs/architecture/auth-rbac.md](../../../../docs/architecture/auth-rbac.md) §7.
 */
import ky, { type KyInstance, type BeforeRequestHook } from "ky";
import { normalizeUrl } from "./shared.js";

/** Init accepted by {@link apiFetch}. Adds a couple of client-only knobs to `RequestInit`. */
export interface ApiFetchInit extends RequestInit {
  /** Redact entire request/response log bodies when registering or validating credentials. */
  sensitiveBody?: boolean;
  /**
   * Skip `Authorization` header injection for this request (e.g. truly public
   * endpoints). Defaults to `false` — every Scope API call is authenticated.
   */
  skipAuth?: boolean;
  /**
   * Project id to scope this request to. When set, it is appended as a
   * `projectId=<id>` query parameter (joined with `?` or `&` as needed). The
   * Scope API requires this on every scoped resource call and never assumes a
   * default, so scoped commands resolve a concrete id (see
   * {@link file://./config.ts resolveProjectId}/`requireProjectId`) and pass it
   * here. Point-read and unscoped calls omit it.
   */
  projectId?: string;
}

/**
 * Resolves the bearer token to attach to outgoing Scope API requests.
 * Returning `undefined` means "no token available" — the request goes out
 * unauthenticated and the server decides whether that is allowed.
 */
export type TokenProvider = () => string | undefined | Promise<string | undefined>;

/**
 * Invoked when the API returns `401 Unauthorized`. Implementations should
 * attempt to refresh/re-acquire credentials and return `true` to signal that
 * the original request should be retried once. Returning `false`/`undefined`
 * (or the absence of a handler) leaves the `401` response untouched so the
 * caller can render its own error.
 */
export type ReauthHandler = (response: Response) => boolean | Promise<boolean>;

/** A single request/response observation handed to the logging sink. */
export interface ApiLogEntry {
  /** Correlation id unique to this request attempt. */
  id: string;
  method: string;
  url: string;
  /** Outgoing headers, already redacted. */
  requestHeaders: Record<string, string>;
  /** Outgoing body preview (size-capped, redacted). `undefined` for bodies we don't capture (e.g. streams). */
  requestBody?: string;
  status?: number;
  statusText?: string;
  /** Incoming body preview (size-capped, redacted). Only captured for non-streaming responses. */
  responseBody?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Populated when the request threw instead of producing a response. */
  error?: string;
}

/** Sink that receives a redacted record of every request/response. */
export interface ApiLogSink {
  record(entry: ApiLogEntry): void;
}

// ── Pluggable seams ──────────────────────────────────────────────────────────

const defaultTokenProvider: TokenProvider = () => process.env.SCOPE_TOKEN || undefined;

/**
 * Default API base path prefixed to every call-site path. Call sites pass
 * resource-relative paths (e.g. `/requests/${id}`) and {@link apiFetch} joins
 * this prefix on, so the version segment lives in one place.
 */
export const DEFAULT_API_BASE_PATH = "/api/v1";

let tokenProvider: TokenProvider = defaultTokenProvider;
let reauthHandler: ReauthHandler | undefined;
let logSink: ApiLogSink | undefined;
let apiBasePath = DEFAULT_API_BASE_PATH;
/** Cached `ky` instance backing {@link apiFetch}; created lazily by {@link getClient}. */
let client: KyInstance | undefined;

/** Override how bearer tokens are resolved (wired by CLI auth — subtask 8). */
export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

/**
 * Override the API base path joined ahead of every call-site path. Accepts
 * values with or without a leading slash; trailing slashes are normalized away.
 * Pass an empty string to disable prefixing entirely (call sites then supply
 * the full path). Defaults to {@link DEFAULT_API_BASE_PATH}.
 */
export function setApiBasePath(path: string): void {
  apiBasePath = normalizeBasePath(path);
}

/** The API base path currently joined ahead of call-site paths. */
export function getApiBasePath(): string {
  return apiBasePath;
}

/** Register a `401` re-auth handler. Pass `undefined` to clear it. */
export function setReauthHandler(handler: ReauthHandler | undefined): void {
  reauthHandler = handler;
}

/** Register a logging sink. Pass `undefined` to disable request logging. */
export function setApiLogSink(sink: ApiLogSink | undefined): void {
  logSink = sink;
}

/** Reset all seams to their defaults. Primarily for tests. */
export function resetApiClient(): void {
  tokenProvider = defaultTokenProvider;
  reauthHandler = undefined;
  logSink = undefined;
  apiBasePath = DEFAULT_API_BASE_PATH;
  client = undefined;
}

// ── Redaction ────────────────────────────────────────────────────────────────

/** Header names whose values must never be logged. */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-internal-api-key",
]);

const REDACTED = "[REDACTED]";

/** Largest body preview captured for logging, in characters. */
const MAX_BODY_LOG_CHARS = 2048;

/**
 * Redact sensitive header values. Returns a plain object with sensitive values
 * replaced by `[REDACTED]`. Header-name matching is case-insensitive.
 */
export function redactHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: [string, string][] = headers instanceof Headers
    ? [...headers.entries()]
    : Array.isArray(headers)
      ? headers
      : Object.entries(headers);
  for (const [name, val] of entries) {
    out[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? REDACTED : val;
  }
  return out;
}

/**
 * Redact obvious secrets embedded in a free-form string (request/response
 * bodies). Conservative on purpose: scrubs bearer tokens and common
 * token/secret/password JSON fields. Never throws.
 */
export function redactString(input: string): string {
  let out = input;
  // `Bearer <token>` anywhere in the text.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  // JSON-ish secret fields: "token": "..."  /  "password":"..." etc.
  out = out.replace(
    /("(?:[a-z0-9_-]*(?:token|secret|password|api[_-]?key|authorization)[a-z0-9_-]*)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    `$1"${REDACTED}"`,
  );
  return out;
}

/**
 * Largest response body we're willing to read for a log preview, in bytes.
 *
 * If the response declares a `Content-Length` larger than this, we skip capture
 * up front and record a marker instead. Otherwise we read up to this many bytes
 * from a clone and then cancel the clone's stream to bound memory/time.
 */
const MAX_RESPONSE_CAPTURE_BYTES = 64 * 1024;

/**
 * Whether a response `Content-Type` names a text-ish payload worth capturing
 * for a log preview. Binary payloads (archives, images, octet-stream) and
 * streaming media (`text/event-stream`) are excluded. A missing/blank type is
 * treated as non-capturable — we don't guess at binary data.
 */
function isCapturableContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!type) return false;
  // Streaming media: reading to completion may never resolve.
  if (type === "text/event-stream") return false;
  if (type.startsWith("text/")) return true;
  if (type === "application/json" || type.endsWith("+json")) return true;
  if (type === "application/xml" || type.endsWith("+xml")) return true;
  if (type === "application/x-www-form-urlencoded") return true;
  return false;
}

/** The bare content type (no parameters), for use in a skipped-body marker. */
function contentTypeLabel(contentType: string | null | undefined): string {
  const type = contentType?.split(";", 1)[0]?.trim();
  return type ? type : "unknown";
}

/**
 * Read at most `maxBytes` from a fresh clone of `response`, decode as UTF-8, and
 * return the text. The clone's stream is cancelled once the cap is reached so we
 * never buffer (or wait for) the whole body — this bounds memory use and avoids
 * hanging on long-lived streams. Returns `undefined` when the body is empty or
 * unreadable. Never consumes the caller's body.
 */
async function readCappedResponseText(response: Response, maxBytes: number): Promise<string | undefined> {
  const clone = response.clone();
  const body = clone.body;
  if (!body) {
    // No stream to bound (e.g. empty body): text() resolves immediately.
    const text = await clone.text();
    return text || undefined;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        // Clamp the final chunk so we never buffer more than the cap.
        const remaining = maxBytes - total;
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    }
  } finally {
    // Stop the tee'd stream; ignore errors from an already-closed reader.
    await reader.cancel().catch(() => {});
  }
  if (total === 0) return undefined;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged) || undefined;
}

/**
 * Build a size-capped, redacted preview of a response body for the log sink,
 * without consuming the caller's body. Bodies that are binary, streaming, or
 * declare an oversized `Content-Length` are skipped with an explanatory marker
 * rather than buffered.
 */
async function captureResponseBody(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type");
  if (!isCapturableContentType(contentType)) {
    return `[${contentTypeLabel(contentType)} body, not captured]`;
  }

  const contentLengthRaw = response.headers.get("content-length");
  if (contentLengthRaw != null) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_CAPTURE_BYTES) {
      return `[${contentLength} bytes, not captured]`;
    }
  }

  try {
    const text = await readCappedResponseText(response, MAX_RESPONSE_CAPTURE_BYTES);
    if (!text) return undefined;
    const capped = text.length > MAX_BODY_LOG_CHARS ? `${text.slice(0, MAX_BODY_LOG_CHARS)}…` : text;
    return redactString(capped);
  } catch {
    return undefined;
  }
}

/** Cap + redact a body value for logging. Returns `undefined` for un-loggable bodies. */
function previewBody(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") {
    const capped = body.length > MAX_BODY_LOG_CHARS ? `${body.slice(0, MAX_BODY_LOG_CHARS)}…` : body;
    return redactString(capped);
  }
  // FormData / Blob / streams / typed arrays: don't attempt to serialize.
  if (typeof FormData !== "undefined" && body instanceof FormData) return "[FormData]";
  if (typeof Blob !== "undefined" && body instanceof Blob) return `[Blob ${body.size}B]`;
  return "[binary]";
}

// ── Error shaping ────────────────────────────────────────────────────────────

/**
 * Structured error for non-OK Scope API responses. Call sites that don't need
 * bespoke per-status messaging can `throw await readApiError(response)` and let
 * a single `catch` render `error.message`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  /** Parsed error body, when the server returned JSON. */
  readonly body: unknown;

  constructor(status: number, statusText: string, body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

/**
 * Build an {@link ApiError} from a non-OK response, extracting the most useful
 * message from a JSON `{ error }`/`{ message }` body, falling back to status text.
 */
export async function readApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    body = await response.json();
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const candidate = b.error ?? b.message;
      if (typeof candidate === "string" && candidate.length > 0) {
        message = candidate;
      } else {
        message = JSON.stringify(body);
      }
    }
  } catch {
    // Non-JSON body — keep the status-text message.
  }
  return new ApiError(response.status, response.statusText, body, message);
}

// ── apiFetch ─────────────────────────────────────────────────────────────────

function ensureLeadingSlash(path: string): string {
  if (path === "" || path.startsWith("/") || path.startsWith("?")) return path;
  return `/${path}`;
}

/** Normalize a base path: ensure a single leading slash and drop trailing ones. `""` disables prefixing. */
function normalizeBasePath(path: string): string {
  if (!path) return "";
  const withLeading = path.startsWith("/") ? path : `/${path}`;
  return withLeading.replace(/\/+$/, "");
}

/**
 * Join the configured {@link apiBasePath} ahead of a call-site path. Call sites
 * pass resource-relative paths (e.g. `/requests`); the version prefix is added
 * here. As a backward-compat guard, paths that already start with the base path
 * are passed through unchanged so an explicit `/api/v1/...` is never doubled.
 */
function resolveApiPath(path: string): string {
  const rel = ensureLeadingSlash(path);
  if (!apiBasePath) return rel;
  if (rel === apiBasePath || rel.startsWith(`${apiBasePath}/`) || rel.startsWith(`${apiBasePath}?`)) {
    return rel;
  }
  return `${apiBasePath}${rel}`;
}

/**
 * Append a `projectId=<id>` query parameter to an already-resolved path,
 * choosing `?` or `&` depending on whether the path already has a query string.
 * A blank/undefined id is a no-op so unscoped and point-read calls pass through
 * unchanged.
 */
function withProjectId(path: string, projectId: string | undefined): string {
  const id = projectId?.trim();
  if (!id) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}projectId=${encodeURIComponent(id)}`;
}

function newCorrelationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Header set on a request to tell the auth hook to skip `Authorization`
 * injection. Stripped from the outgoing request inside the hook so it never
 * goes over the wire.
 */
const SKIP_AUTH_HEADER = "x-scope-skip-auth";

/**
 * `ky` `beforeRequest` hook: inject `Authorization: Bearer <token>` from the
 * current {@link tokenProvider}. Honours the {@link SKIP_AUTH_HEADER} marker and
 * never clobbers a caller-supplied `Authorization`.
 */
const authHook: BeforeRequestHook = async ({ request }) => {
  const skip = request.headers.has(SKIP_AUTH_HEADER);
  request.headers.delete(SKIP_AUTH_HEADER);
  if (skip) return;
  if (request.headers.has("authorization")) return;
  const token = await tokenProvider();
  if (token) request.headers.set("authorization", `Bearer ${token}`);
};

/** Lazily create (and cache) the shared `ky` instance backing {@link apiFetch}. */
function getClient(): KyInstance {
  if (!client) {
    client = ky.create({
      // Call sites do their own `response.ok`/status handling — never throw.
      throwHttpErrors: false,
      // The CLI manages its own timeouts/cancellation via `signal`.
      timeout: false,
      // Preserve exact single-attempt behavior; the facade owns the one 401 retry.
      // NOTE: transient-failure retries are intentionally disabled here to avoid
      // stacking with the shared cockatiel `withRetry`/`@Retry`
      // (packages/shared/src/utils/retry.ts). If the CLI ever needs to retry
      // transient 429/503s, pick ONE layer — enable ky's `retry` (with its own
      // backoff) or wrap `apiFetch` in `withRetry` — never both, or attempts
      // compound to `maxRetries × ky.limit`.
      retry: 0,
      hooks: { beforeRequest: [authHook] },
    });
  }
  return client;
}

/**
 * Perform an authenticated Scope API request.
 *
 * @param baseUrl Raw API base URL (e.g. the command's `--url`/`SCOPE_API_URL`).
 *                Trailing slashes are normalized away.
 * @param path    Resource-relative path (and optional query string), e.g.
 *                `/requests/${id}`. The configurable API base path
 *                ({@link DEFAULT_API_BASE_PATH}, default `/api/v1`) is joined on
 *                automatically; an explicit `/api/v1/...` is still accepted.
 * @param init    Standard `RequestInit` plus the {@link ApiFetchInit} extras.
 * @returns The `fetch` `Response`. Callers keep their existing
 *          `response.ok` / `response.json()` / streaming handling.
 */
export async function apiFetch(baseUrl: string | undefined, path: string, init?: ApiFetchInit): Promise<Response> {
  const url = `${normalizeUrl(baseUrl)}${withProjectId(resolveApiPath(path), init?.projectId)}`;

  const headers = new Headers(init?.headers);
  if (init?.skipAuth) headers.set(SKIP_AUTH_HEADER, "1");

  // Strip our client-only fields before handing the init to ky.
  const { skipAuth: _skipAuth, projectId: _projectId, sensitiveBody: _sensitiveBody, ...rest } = init ?? {};
  const finalInit: RequestInit = { ...rest, headers };

  let response = await dispatch(url, finalInit, init?.body, init?.sensitiveBody);

  if (response.status === 401 && reauthHandler) {
    const shouldRetry = await reauthHandler(response);
    if (shouldRetry) {
      // Re-dispatch: the auth hook re-resolves the (possibly refreshed) token.
      response = await dispatch(url, finalInit, init?.body, init?.sensitiveBody);
    }
  }

  return response;
}

/** Single request attempt through `ky`, wrapped with logging-sink instrumentation. */
async function dispatch(url: string, init: RequestInit, originalBody: BodyInit | null | undefined, sensitiveBody = false): Promise<Response> {
  const send = getClient();
  if (!logSink) {
    return send(url, init);
  }

  const id = newCorrelationId();
  const start = Date.now();
  const base: Omit<ApiLogEntry, "status" | "statusText" | "responseBody" | "error" | "durationMs"> = {
    id,
    method: (init.method ?? "GET").toUpperCase(),
    url,
    requestHeaders: redactedRequestHeaders(init.headers),
    requestBody: sensitiveBody ? REDACTED : previewBody(originalBody),
  };

  try {
    const response = await send(url, init);
    // Capture a redacted preview without consuming the caller's body stream.
    // Gated on content type/length so binary and streaming bodies aren't buffered.
    let responseBody: string | undefined;
    try {
      responseBody = sensitiveBody ? REDACTED : await captureResponseBody(response);
    } catch {
      responseBody = undefined;
    }
    logSink.record({
      ...base,
      status: response.status,
      statusText: response.statusText,
      responseBody,
      durationMs: Date.now() - start,
    });
    return response;
  } catch (error) {
    logSink.record({
      ...base,
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Build the redacted request-header map for the log sink. Drops the internal
 * skip-auth marker and, when the auth hook will inject a bearer token, records a
 * redacted `authorization` placeholder so the log reflects that the request was
 * authenticated (the sink never sees the real token).
 */
function redactedRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out = redactHeaders(headers);
  const h = headers instanceof Headers ? headers : new Headers(headers);
  const willInjectAuth = !h.has("authorization") && !h.has(SKIP_AUTH_HEADER);
  delete out[SKIP_AUTH_HEADER];
  if (willInjectAuth) out["authorization"] = REDACTED;
  return out;
}
