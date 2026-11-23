// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { artifactFilename, artifactUrl, ArtifactError, downloadArtifact, downloadBatchArtifacts, fetchArtifact } from "./artifact-delivery";
import { resetApiClient, setApiTokenProvider, setReauthHandler } from "./api-client";

const path = "/api/v1/requests/request-1/runs/attempt-1/archive";
const controller = () => new AbortController();
const archive = (body: BodyInit = new Uint8Array([31, 139, 0, 255])) =>
  new Response(body, { headers: { "content-type": "application/gzip", "content-disposition": "attachment; filename=run.tar.gz" } });

describe("authenticated artifact delivery", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
  let create: MockInstance<typeof URL.createObjectURL>;
  let revoke: MockInstance<typeof URL.revokeObjectURL>;

  beforeEach(() => {
    resetApiClient();
    vi.stubGlobal("window", Object.assign(new EventTarget(), {
      location: { href: "https://scope.test/runs/request-1", origin: "https://scope.test" },
    }));
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    anchor.click.mockReset();
    anchor.remove.mockReset();
    create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:scope-download");
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    resetApiClient();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    "/api/v1/requests/r/archive",
    "/api/v1/requests/r/runs/a/har?iteration=2",
    "/api/v1/requests/r/runs/a/atif?iteration=2",
    "/api/v1/requests/r/snapshots/1",
    "/api/v1/requests/r/tool-calls?iteration=1",
    "/api/v1/codebase-revisions/rev-1/archive",
    "/api/v1/requests/r/video?phase=setup&index=1",
  ])("binds canonical route %s to the explicit project", (url) => {
    expect(artifactUrl(url, "project-1").searchParams.get("projectId")).toBe("project-1");
  });

  it.each([
    "https://foreign.test/api/v1/requests/r/archive",
    "//foreign.test/api/v1/requests/r/archive",
    "https://user:password@scope.test/api/v1/requests/r/archive",
    "/api/v1/requests/r/archive?token=secret",
    "/api/v1/requests/r/archive?projectId=other",
    "/api/v1/requests/r/archive?projectId=p&projectId=p",
    "/api/v1/requests/r/archive#fragment",
    "/api/v1/requests/r/har?iteration=0",
    "/api/v1/requests/r/har?iteration=1x",
    "/api/v1/requests/r/video?index=-1",
    "/api/v1/requests/r/video?phase=unknown",
    "/api/v1/users/me",
    "blob:https://scope.test/file",
  ])("rejects unsafe route %s before credentials are acquired", async (url) => {
    const provider = vi.fn();
    setApiTokenProvider(provider);
    await expect(fetchArtifact(url, "p", controller().signal)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a project", () => {
    expect(() => artifactUrl(path, "")).toThrow("project-bound");
  });

  it.each([
    ['attachment; filename="plain.tar.gz"', "plain.tar.gz"],
    ["attachment; filename=plain.har", "plain.har"],
    ["attachment; filename=old; filename*=UTF-8''caf%C3%A9.har", "café.har"],
    ["attachment; filename*=UTF-8'en'%E2%82%AC.har", "€.har"],
    ['attachment; filename="../../secret\\r.har"', "_.._secretr.har"],
    ["attachment; filename=...", "fallback.tar.gz"],
    [null, "fallback.tar.gz"],
  ])("uses a safe disposition filename for %s", (disposition, expected) => {
    expect(artifactFilename(disposition, "fallback.tar.gz")).toBe(expected);
  });

  it("sanitizes fallbacks and rejects broken encoded filenames", () => {
    expect(artifactFilename(null, "../bad/\u0000")).toBe("_bad__");
    expect(artifactFilename(null, "...")).toBe("artifact");
    expect(() => artifactFilename("attachment; filename*=UTF-8''%ZZ", "x")).toThrow("invalid encoded filename");
    expect(artifactFilename(null, "a".repeat(250))).toHaveLength(200);
  });

  it("preserves exact gzip bytes, type and filename, and never uses the API URL as a browser href", async () => {
    const original = gzipSync(Buffer.from([0, 1, 2, 255, 128, 0]));
    fetchMock.mockResolvedValue(archive(original));
    setApiTokenProvider(() => "test-token");
    const owner = controller();
    await downloadArtifact(path, "p", owner.signal);
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.headers.has("authorization")).toBe(true);
    expect(request.redirect).toBe("error");
    expect(request.credentials).toBe("omit");
    expect(request.cache).toBe("no-store");
    expect(new URL(request.url).searchParams.get("projectId")).toBe("p");
    const blob = create.mock.calls[0][0] as Blob;
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(original);
    expect(gunzipSync(Buffer.from(await blob.arrayBuffer()))).toEqual(Buffer.from([0, 1, 2, 255, 128, 0]));
    expect(blob.type).toBe("application/gzip");
    expect(anchor.href).toBe("blob:scope-download");
    expect(anchor.download).toBe("run.tar.gz");
    expect(anchor.click).toHaveBeenCalledTimes(1);
    owner.abort();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:scope-download");
  });

  it.each([
    ["/api/v1/requests/r/har", "application/json"],
    ["/api/v1/requests/r/atif?iteration=1", "application/json"],
    ["/api/v1/requests/r/tool-calls?iteration=1", "application/x-ndjson"],
    ["/api/v1/codebase-revisions/rev/archive", "application/gzip"],
  ])("downloads %s without transforming bytes", async (url, type) => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    fetchMock.mockResolvedValue(new Response(bytes, { headers: { "content-type": type } }));
    await downloadArtifact(url, "p", controller().signal, "fallback");
    expect(new Uint8Array(await (create.mock.calls[0][0] as Blob).arrayBuffer())).toEqual(bytes);
  });

  it("delegates exactly one 401 refresh to apiClient", async () => {
    const provider = vi.fn(() => "test-token");
    setApiTokenProvider(provider);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(archive());
    await downloadArtifact(path, "p", controller().signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenCalledWith({ forceRefresh: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 416])("never saves an HTTP %s error as an artifact", async status => {
    const reauth = vi.fn();
    setReauthHandler(reauth);
    fetchMock.mockImplementation(async () => new Response('{"error":"Denied"}', {
      status, headers: { "content-type": "application/json", "content-range": "bytes */10" },
    }));
    await expect(downloadArtifact(path, "p", controller().signal)).rejects.toMatchObject({
      status, headers: expect.any(Headers),
    });
    expect(fetchMock).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
    expect(reauth).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(create).not.toHaveBeenCalled();
  });

  it("retains range headers and status even for malformed error JSON", async () => {
    fetchMock.mockResolvedValue(new Response("invalid", {
      status: 416, headers: { "content-type": "application/json", "content-range": "bytes */10" },
    }));
    try {
      await fetchArtifact("/api/v1/requests/r/video", "p", controller().signal, "bytes=99-");
      expect.fail("Expected a 416");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactError);
      expect((error as ArtifactError).headers?.get("content-range")).toBe("bytes */10");
      expect((error as ArtifactError).status).toBe(416);
    }
  });

  it("caps transient GET retries and surfaces exhausted 503 without saving", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response('{"error":"Unavailable"}', {
      status: 503, headers: { "content-type": "application/json" },
    }));
    const result = downloadArtifact(path, "p", controller().signal);
    const assertion = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves Range and accepts a 206 only when requested", async () => {
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1]), {
      status: 206, headers: { "content-type": "video/webm", "content-range": "bytes 1-1/2" },
    }));
    const response = await fetchArtifact("/api/v1/requests/r/video", "p", controller().signal, "bytes=1-1");
    expect(response.status).toBe(206);
    expect((fetchMock.mock.calls[0][0] as Request).headers.get("range")).toBe("bytes=1-1");
    await expect(fetchArtifact("/api/v1/requests/r/video", "p", controller().signal)).rejects.toThrow("incomplete");
  });

  it.each(["text/html", "application/json"])("rejects a successful archive with type %s", async type => {
    fetchMock.mockResolvedValue(new Response("not an archive", { headers: { "content-type": type } }));
    await expect(downloadArtifact(path, "p", controller().signal)).rejects.toThrow("content type");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects redirects even if a transport incorrectly returns one", async () => {
    vi.spyOn(Response.prototype, "redirected", "get").mockReturnValue(true);
    fetchMock.mockResolvedValue(archive());
    await expect(downloadArtifact(path, "p", controller().signal)).rejects.toThrow("redirects");
    expect(create).not.toHaveBeenCalled();
  });

  it("aborts stalled body reads and cancels the stream without saving late bytes", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(archive(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel })));
    const owner = controller();
    const result = downloadArtifact(path, "p", owner.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    owner.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not fetch when already cancelled", async () => {
    const owner = controller();
    owner.abort();
    await expect(downloadArtifact(path, "p", owner.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cleans up after deferred browser dispatch, page teardown and dispatch failures", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => archive());
    await downloadArtifact(path, "p", controller().signal);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoke).toHaveBeenCalledTimes(1);
    await downloadArtifact(path, "p", controller().signal);
    window.dispatchEvent(new Event("pagehide"));
    expect(revoke).toHaveBeenCalledTimes(2);
    anchor.click.mockImplementationOnce(() => { throw new Error("Browser refused download"); });
    await expect(downloadArtifact(path, "p", controller().signal)).rejects.toThrow("Browser refused");
    expect(revoke).toHaveBeenCalledTimes(3);
  });

  it.each([403, 503])("never retries a batch POST on %s", async status => {
    fetchMock.mockResolvedValue(new Response("{}", { status, headers: { "content-type": "application/json" } }));
    await expect(downloadBatchArtifacts(["r1", "r2"], "p", controller().signal)).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("never retries a batch POST after an uncertain network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(downloadBatchArtifacts(["r1"], "p", controller().signal)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a browser network failure wrapped by the real apiClient", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(archive());
    const result = downloadArtifact(path, "p", controller().signal);
    const assertion = expect(result).resolves.toBeUndefined();
    await Promise.all([assertion, vi.runAllTimersAsync()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("caps browser network retries at three establishment attempts", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const assertion = expect(downloadArtifact(path, "p", controller().signal))
      .rejects.toMatchObject({ name: "NetworkError" });
    await Promise.all([assertion, vi.runAllTimersAsync()]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(create).not.toHaveBeenCalled();
  });

  it("cancels network backoff without establishing another request", async () => {
    vi.useFakeTimers();
    const owner = controller();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const assertion = expect(downloadArtifact(path, "p", owner.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    owner.abort();
    await assertion;
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not retry non-network transport errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("Invalid request configuration"));
    await expect(downloadArtifact(path, "p", controller().signal))
      .rejects.toThrow("Invalid request configuration");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("never restarts a failed accepted body", async () => {
    fetchMock.mockResolvedValue(archive(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array([1])); c.error(new TypeError("Failed to fetch")); },
    })));
    await expect(downloadArtifact(path, "p", controller().signal)).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("posts the selected batch once with explicit project and binary response", async () => {
    let body: unknown;
    fetchMock.mockImplementation(async input => {
      body = await (input as Request).clone().json();
      return archive();
    });
    await downloadBatchArtifacts(["r1", "r2"], "p", controller().signal);
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.method).toBe("POST");
    expect(body).toEqual({ ids: ["r1", "r2"] });
    expect(new URL(request.url).searchParams.get("projectId")).toBe("p");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });
});
