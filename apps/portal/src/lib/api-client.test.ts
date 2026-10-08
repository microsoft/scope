// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiClient,
  resetApiClient,
  setApiTokenProvider,
  setReauthHandler,
  setApiSessionSignal,
} from "./api-client";

/** Read the Authorization header off whatever ky passed to `fetch`. */
function authHeaderOf(call: unknown[]): string | null {
  const [input, init] = call as [RequestInfo | URL, RequestInit | undefined];
  if (input instanceof Request) return input.headers.get("authorization");
  return new Headers(init?.headers).get("authorization");
}

describe("portal api-client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetApiClient();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiClient();
  });

  it("injects a Bearer token from the token provider", async () => {
    setApiTokenProvider(() => "tok-1");
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await apiClient("https://scope.test/api/v1/ping");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer tok-1");
  });

  it("sends no Authorization header when no token is available", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await apiClient("https://scope.test/api/v1/ping");

    expect(authHeaderOf(fetchMock.mock.calls[0])).toBeNull();
  });

  it("never clobbers a caller-supplied Authorization header", async () => {
    setApiTokenProvider(() => "tok-1");
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await apiClient("https://scope.test/api/v1/ping", {
      headers: { authorization: "Bearer caller-supplied" },
    });

    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer caller-supplied");
  });

  it("on 401 forces a token refresh, retries once, and succeeds without re-auth", async () => {
    const provider = vi
      .fn()
      .mockResolvedValueOnce("tok-1")
      .mockResolvedValueOnce("tok-2");
    const reauth = vi.fn();
    setApiTokenProvider(provider);
    setReauthHandler(reauth);
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const res = await apiClient("https://scope.test/api/v1/ping");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry carried the force-refreshed token.
    expect(provider).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer tok-1");
    expect(authHeaderOf(fetchMock.mock.calls[1])).toBe("Bearer tok-2");
    expect(reauth).not.toHaveBeenCalled();
  });

  it("triggers the re-auth handler when a 401 survives the forced-refresh retry", async () => {
    setApiTokenProvider(() => "tok");
    const reauth = vi.fn();
    setReauthHandler(reauth);
    fetchMock.mockImplementation(
      async () => new Response("", { status: 401 }),
    );

    const res = await apiClient("https://scope.test/api/v1/ping");

    expect(res.status).toBe(401);
    // Initial attempt + a single auth-scoped retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reauth).toHaveBeenCalledTimes(1);
  });

  it.each([403, 503])("does not retry or redirect on %s", async (status) => {
    const provider = vi.fn(() => "idp-token");
    const reauth = vi.fn();
    setApiTokenProvider(provider);
    setReauthHandler(reauth);
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    expect((await apiClient("https://scope.test/api/v1/users/me")).status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(reauth).not.toHaveBeenCalled();
  });

  it("does not send an old account's request if it is cancelled during token acquisition", async () => {
    const controller = new AbortController();
    let resolve!: (token: string) => void;
    const token = new Promise<string>((done) => { resolve = done; });
    const provider = vi.fn(() => token);
    setApiTokenProvider(provider);
    setApiSessionSignal(controller.signal);
    const result = apiClient("https://scope.test/api/v1/users/me");
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    controller.abort();
    resolve("old-account-token");
    await rejection;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves POST bodies through the session signal and the existing 401 retry", async () => {
    setApiSessionSignal(new AbortController().signal);
    setApiTokenProvider(() => "idp-token");
    const bodies: string[] = [];
    fetchMock.mockImplementation(async (request: Request) => {
      bodies.push(await request.clone().text());
      return new Response("{}", { status: bodies.length === 1 ? 401 : 200 });
    });
    const result = await apiClient.post("https://scope.test/api/v1/projects", {
      json: { name: "My project" },
    });
    expect(result.status).toBe(200);
    expect(bodies).toEqual(['{"name":"My project"}', '{"name":"My project"}']);
  });
});
