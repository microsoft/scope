// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createProxyClient } from "./index.js";

describe("createProxyClient (devproxy backend)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.PROXY_BACKEND = "devproxy";
    delete process.env.DEV_PROXY_URL;
    delete process.env.DEV_PROXY_API_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses DEV_PROXY_URL as the proxy URL", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-claude-code:18897";
    process.env.DEV_PROXY_URL = "http://devproxy-claude-code:18000";
    const client = createProxyClient();
    expect(client.backend).toBe("devproxy");
    expect(client.apiUrl).toBe("http://devproxy-claude-code:18897");
    expect(client.proxyUrl).toBe("http://devproxy-claude-code:18000");
  });

  it("preserves the explicit legacy backend for remaining DevProxy workers", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-claude-code:18897";
    process.env.DEV_PROXY_URL = "http://devproxy-claude-code:18000";
    const client = createProxyClient();
    expect(client.backend).toBe("devproxy");
  });

  it("never returns the management API URL as the proxy URL", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-claude-code:18897";
    process.env.DEV_PROXY_URL = "http://devproxy-claude-code:18000";
    const client = createProxyClient();
    // Regression guard for the bug that caused
    // "-32000 Authentication required" in the copilot worker: the worker
    // was setting HTTP_PROXY to the API port (18897), making every HTTPS
    // request fail.
    expect(client.proxyUrl).not.toBe(client.apiUrl);
    expect(client.proxyUrl).not.toContain(":18897");
  });

  it("throws when DEV_PROXY_URL is missing", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-claude-code:18897";
    expect(() => createProxyClient()).toThrowError(/DEV_PROXY_URL must be set/);
  });
});

describe("createProxyClient (gateway backend)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.PROXY_BACKEND;
    delete process.env.DEV_PROXY_URL;
    delete process.env.DEV_PROXY_API_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("selects the gateway backend when PROXY_BACKEND=gateway", () => {
    process.env.PROXY_BACKEND = "gateway";
    process.env.DEV_PROXY_API_URL =
      "http://gateway-service.scoped.svc.cluster.local:18000";
    const client = createProxyClient();
    expect(client.backend).toBe("gateway");
    expect(client.apiUrl).toBe(
      "http://gateway-service.scoped.svc.cluster.local:18000",
    );
  });

  it("does not require DEV_PROXY_URL (proxy URL comes from the gateway session)", () => {
    process.env.PROXY_BACKEND = "gateway";
    process.env.DEV_PROXY_API_URL = "http://gateway:18000";
    // Unlike the devproxy backend, the gateway backend must not throw when
    // DEV_PROXY_URL is unset — the per-session proxy URL is issued by the
    // gateway at session start, not read from the environment.
    expect(() => createProxyClient()).not.toThrow();
  });

  it("defaults the api URL to localhost:18000 when DEV_PROXY_API_URL is unset", () => {
    process.env.PROXY_BACKEND = "gateway";
    const client = createProxyClient();
    expect(client.backend).toBe("gateway");
    expect(client.apiUrl).toBe("http://localhost:18000");
  });

  it("defaults to the gateway backend when PROXY_BACKEND is unset", () => {
    const client = createProxyClient();
    expect(client.backend).toBe("gateway");
    expect(client.apiUrl).toBe("http://localhost:18000");
  });
});
