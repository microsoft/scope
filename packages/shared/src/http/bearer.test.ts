// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { bearerHeaders, fetchWithBearer } from "./bearer.js";

describe("bearer helpers", () => {
  const fetchMock = vi.fn(async () => new Response("ok"));

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("returns no headers without a token", () => {
    expect(bearerHeaders()).toEqual({});
    expect(bearerHeaders(() => undefined)).toEqual({});
  });

  it("returns an Authorization header with a token", () => {
    expect(bearerHeaders(() => "abc")).toEqual({ Authorization: "Bearer abc" });
  });

  it("forwards the original arguments when no token is available", async () => {
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithBearer("http://api/x");
    expect(fetchMock).toHaveBeenCalledWith("http://api/x");
    await fetchWithBearer("http://api/y", () => undefined, { method: "GET" });
    expect(fetchMock).toHaveBeenLastCalledWith("http://api/y", { method: "GET" });
  });

  it("merges the bearer into plain-object headers", async () => {
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithBearer("http://api/x", () => "tok", { headers: { Accept: "application/json" } });
    expect(fetchMock).toHaveBeenCalledWith("http://api/x", {
      headers: { Accept: "application/json", Authorization: "Bearer tok" },
    });
  });

  it("merges the bearer into Headers instances", async () => {
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithBearer("http://api/x", () => "tok", { headers: new Headers({ Accept: "a" }) });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
    expect(new Headers(init.headers).get("accept")).toBe("a");
  });
});
