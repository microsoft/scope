// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiFetch,
  DEFAULT_API_BASE_PATH,
  getApiBasePath,
  readApiError,
  redactHeaders,
  redactString,
  resetApiClient,
  setApiBasePath,
  setApiLogSink,
  setReauthHandler,
  setTokenProvider,
  type ApiLogEntry,
} from "./api-client.js";

function okJson(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The `Request` that the internal `ky` engine handed to the stubbed `fetch` for
 * the given call. `ky` invokes `fetch(request, options)` — the first arg is a
 * `Request`, not a URL string — so transport assertions inspect it here.
 */
function reqOf(mock: ReturnType<typeof vi.fn>, call = 0): Request {
  return mock.mock.calls[call][0] as Request;
}

describe("apiFetch URL handling", () => {
  beforeEach(() => {
    resetApiClient();
    delete process.env.SCOPE_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetApiClient();
  });

  it.each([undefined, "", "  "])("rejects missing URL %j before any network request", async (url) => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);

    await expect(apiFetch(url, "/projects")).rejects.toThrow("No API URL configured");
    expect(mock).not.toHaveBeenCalled();
  });

  it("joins base + path and normalizes trailing slashes", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100///", "/api/v1/criteria");

    expect(mock).toHaveBeenCalledTimes(1);
    expect(reqOf(mock).url).toBe("http://localhost:3100/api/v1/criteria");
  });

  it("preserves query strings and adds a leading slash when missing", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "api/v1/requests?worker=copilot");

    expect(reqOf(mock).url).toBe("http://localhost:3100/api/v1/requests?worker=copilot");
  });

  it("passes method and body through unchanged", async () => {
    let sentBody: string | undefined;
    const mock = vi.fn(async (req: Request) => {
      sentBody = await req.text();
      return okJson();
    });
    vi.stubGlobal("fetch", mock);

    const body = JSON.stringify({ force: true });
    await apiFetch("http://localhost:3100", "/api/v1/requests/x/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(reqOf(mock).method).toBe("POST");
    expect(sentBody).toBe(body);
  });
});

describe("apiFetch base path", () => {
  beforeEach(() => {
    resetApiClient();
    delete process.env.SCOPE_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetApiClient();
  });

  it("defaults to /api/v1 and prefixes resource-relative paths", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    expect(getApiBasePath()).toBe(DEFAULT_API_BASE_PATH);
    await apiFetch("http://localhost:3100", "/criteria");

    expect(reqOf(mock).url).toBe("http://localhost:3100/api/v1/criteria");
  });

  it("adds a leading slash to a relative path before prefixing", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "criteria");

    expect(reqOf(mock).url).toBe("http://localhost:3100/api/v1/criteria");
  });

  it("does not double the prefix when a path already includes the base path", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(reqOf(mock).url).toBe("http://localhost:3100/api/v1/criteria");
  });

  it("honors a custom base path and normalizes its slashes", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    setApiBasePath("api/v2/");
    expect(getApiBasePath()).toBe("/api/v2");
    await apiFetch("http://localhost:3100", "/criteria");

    expect(reqOf(mock).url).toBe("http://localhost:3100/api/v2/criteria");
  });

  it("disables prefixing when the base path is empty", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    setApiBasePath("");
    expect(getApiBasePath()).toBe("");
    await apiFetch("http://localhost:3100", "/health");

    expect(reqOf(mock).url).toBe("http://localhost:3100/health");
  });

  it("resetApiClient restores the default base path", () => {
    setApiBasePath("/custom");
    expect(getApiBasePath()).toBe("/custom");
    resetApiClient();
    expect(getApiBasePath()).toBe(DEFAULT_API_BASE_PATH);
  });
});

describe("apiFetch auth injection", () => {
  beforeEach(() => {
    resetApiClient();
    delete process.env.SCOPE_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetApiClient();
    delete process.env.SCOPE_TOKEN;
  });

  it("does not set Authorization when no token is available", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(reqOf(mock).headers.has("authorization")).toBe(false);
  });

  it("injects Authorization: Bearer from SCOPE_TOKEN", async () => {
    process.env.SCOPE_TOKEN = "raw-bearer-123";
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(reqOf(mock).headers.get("authorization")).toBe("Bearer raw-bearer-123");
  });

  it("uses a custom token provider when set", async () => {
    setTokenProvider(() => "provider-token");
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(reqOf(mock).headers.get("authorization")).toBe("Bearer provider-token");
  });

  it("supports an async token provider", async () => {
    setTokenProvider(async () => "async-token");
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(reqOf(mock).headers.get("authorization")).toBe("Bearer async-token");
  });

  it("does not inject auth when skipAuth is set", async () => {
    process.env.SCOPE_TOKEN = "raw-bearer-123";
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/api/v1/criteria", { skipAuth: true });

    const headers = reqOf(mock).headers;
    expect(headers.has("authorization")).toBe(false);
    // The internal skip-auth marker must never leave the client.
    expect(headers.has("x-scope-skip-auth")).toBe(false);
  });

  it("does not clobber a caller-supplied Authorization header", async () => {
    process.env.SCOPE_TOKEN = "raw-bearer-123";
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/api/v1/criteria", {
      headers: { Authorization: "Bearer caller-set" },
    });

    expect(reqOf(mock).headers.get("authorization")).toBe("Bearer caller-set");
  });
});

describe("apiFetch 401 re-auth seam", () => {
  beforeEach(() => {
    resetApiClient();
    delete process.env.SCOPE_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetApiClient();
  });

  it("returns the 401 unchanged when no handler is registered", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", mock);

    const res = await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(res.status).toBe(401);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("retries once when the handler asks for a retry", async () => {
    let token = "stale";
    setTokenProvider(() => token);
    setReauthHandler(() => {
      token = "fresh";
      return true;
    });
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(okJson({ ok: true }));
    vi.stubGlobal("fetch", mock);

    const res = await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
    // The retry re-runs the auth hook, which re-resolves the refreshed token.
    expect(reqOf(mock, 1).headers.get("authorization")).toBe("Bearer fresh");
  });

  it("does not retry when the handler declines", async () => {
    setReauthHandler(() => false);
    const mock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", mock);

    const res = await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(res.status).toBe(401);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("redaction", () => {
  it("redacts sensitive headers case-insensitively", () => {
    const out = redactHeaders({
      Authorization: "Bearer secret",
      "X-Api-Key": "abc",
      "Content-Type": "application/json",
    });
    expect(out["Authorization"]).toBe("[REDACTED]");
    expect(out["X-Api-Key"]).toBe("[REDACTED]");
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("redacts bearer tokens and secret fields in strings", () => {
    expect(redactString("Authorization: Bearer abc.def-123")).toContain("[REDACTED]");
    expect(redactString("Authorization: Bearer abc.def-123")).not.toContain("abc.def-123");

    const json = '{"token":"sk-live-xyz","name":"ok","apiKey":"k-1"}';
    const red = redactString(json);
    expect(red).not.toContain("sk-live-xyz");
    expect(red).not.toContain("k-1");
    expect(red).toContain('"name":"ok"');
  });
});

describe("logging sink", () => {
  beforeEach(() => {
    resetApiClient();
    delete process.env.SCOPE_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetApiClient();
    delete process.env.SCOPE_TOKEN;
  });

  it("records a redacted request/response entry", async () => {
    process.env.SCOPE_TOKEN = "raw-bearer-123";
    const entries: ApiLogEntry[] = [];
    setApiLogSink({ record: (e) => entries.push(e) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ ok: true })));

    await apiFetch("http://localhost:3100", "/api/v1/criteria", {
      method: "POST",
      body: JSON.stringify({ token: "should-be-hidden" }),
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.method).toBe("POST");
    expect(entry.url).toBe("http://localhost:3100/api/v1/criteria");
    expect(entry.status).toBe(200);
    expect(entry.requestHeaders["authorization"]).toBe("[REDACTED]");
    expect(entry.requestBody).not.toContain("should-be-hidden");
    expect(typeof entry.durationMs).toBe("number");
  });

  it("records errors when fetch throws", async () => {
    const entries: ApiLogEntry[] = [];
    setApiLogSink({ record: (e) => entries.push(e) });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(apiFetch("http://localhost:3100", "/api/v1/criteria")).rejects.toThrow("ECONNREFUSED");
    expect(entries).toHaveLength(1);
    expect(entries[0].error).toBe("ECONNREFUSED");
  });

  it("does not consume the caller's response body", async () => {
    setApiLogSink({ record: () => {} });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ value: 42 })));

    const res = await apiFetch("http://localhost:3100", "/api/v1/criteria");
    const body = await res.json();
    expect(body).toEqual({ value: 42 });
  });

  it("captures a redacted preview for JSON responses", async () => {
    const entries: ApiLogEntry[] = [];
    setApiLogSink({ record: (e) => entries.push(e) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ token: "should-be-hidden", value: 42 })));

    await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(entries).toHaveLength(1);
    expect(entries[0].responseBody).toContain("42");
    expect(entries[0].responseBody).not.toContain("should-be-hidden");
  });

  it("skips capturing binary response bodies", async () => {
    const entries: ApiLogEntry[] = [];
    setApiLogSink({ record: (e) => entries.push(e) });
    const archive = new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "application/gzip" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(archive));

    const res = await apiFetch("http://localhost:3100", "/api/v1/requests/abc/archive");

    expect(entries).toHaveLength(1);
    expect(entries[0].responseBody).toBe("[application/gzip body, not captured]");
    // The caller can still read the untouched body.
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("skips capturing streaming (text/event-stream) response bodies", async () => {
    const entries: ApiLogEntry[] = [];
    setApiLogSink({ record: (e) => entries.push(e) });
    const stream = new Response("data: hello\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream));

    await apiFetch("http://localhost:3100", "/api/v1/logs/stream");

    expect(entries).toHaveLength(1);
    expect(entries[0].responseBody).toBe("[text/event-stream body, not captured]");
  });

  it("skips capturing responses that declare an oversized Content-Length", async () => {
    const entries: ApiLogEntry[] = [];
    setApiLogSink({ record: (e) => entries.push(e) });
    const big = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(64 * 1024 + 1) },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(big));

    await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(entries).toHaveLength(1);
    expect(entries[0].responseBody).toBe(`[${64 * 1024 + 1} bytes, not captured]`);
  });

  it("caps large text response previews", async () => {
    const entries: ApiLogEntry[] = [];
    setApiLogSink({ record: (e) => entries.push(e) });
    const long = "a".repeat(5000);
    const res = new Response(long, { status: 200, headers: { "content-type": "text/plain" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));

    await apiFetch("http://localhost:3100", "/api/v1/criteria");

    expect(entries).toHaveLength(1);
    const preview = entries[0].responseBody ?? "";
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThan(long.length);
  });
});

describe("readApiError", () => {
  it("extracts the error field from a JSON body", async () => {
    const err = await readApiError(new Response(JSON.stringify({ error: "Request not found" }), { status: 404 }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Request not found");
  });

  it("falls back to status text for non-JSON bodies", async () => {
    const err = await readApiError(new Response("oops", { status: 500, statusText: "Internal Server Error" }));
    expect(err.message).toBe("Internal Server Error");
  });
});

describe("apiFetch projectId scoping", () => {
  beforeEach(() => {
    resetApiClient();
    delete process.env.SCOPE_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetApiClient();
  });

  it("appends ?projectId when the path has no query string", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/requests", { projectId: "proj-1" });

    expect(reqOf(mock).url).toBe("http://localhost:3100/api/v1/requests?projectId=proj-1");
  });

  it("appends &projectId when the path already has a query string", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/requests?worker=copilot", { projectId: "proj-1" });

    expect(reqOf(mock).url).toBe("http://localhost:3100/api/v1/requests?worker=copilot&projectId=proj-1");
  });

  it("URL-encodes the project id", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/criteria", { projectId: "a b/c" });

    expect(reqOf(mock).url).toBe("http://localhost:3100/api/v1/criteria?projectId=a%20b%2Fc");
  });

  it("omits projectId when it is undefined or blank", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/criteria");
    await apiFetch("http://localhost:3100", "/criteria", { projectId: "   " });

    expect(reqOf(mock, 0).url).toBe("http://localhost:3100/api/v1/criteria");
    expect(reqOf(mock, 1).url).toBe("http://localhost:3100/api/v1/criteria");
  });

  it("does not leak projectId into the request init (headers/body)", async () => {
    const mock = vi.fn().mockResolvedValue(okJson());
    vi.stubGlobal("fetch", mock);

    await apiFetch("http://localhost:3100", "/requests", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      projectId: "proj-1",
    });

    const req = reqOf(mock);
    // projectId rides the query string, never a header, and the resource path
    // (before the query) is untouched.
    expect(req.headers.has("projectId")).toBe(false);
    expect(req.url).toBe("http://localhost:3100/api/v1/requests?projectId=proj-1");
    expect(req.method).toBe("POST");
  });
});
