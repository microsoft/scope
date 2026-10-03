// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProxyClient } from "./index.js";

describe("createProxyClient (devproxy backend)", () => {
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

  it("uses DEV_PROXY_URL as the proxy URL", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-claude-code:18897";
    process.env.DEV_PROXY_URL = "http://devproxy-claude-code:18000";
    const client = createProxyClient();
    expect(client.backend).toBe("devproxy");
    expect(client.apiUrl).toBe("http://devproxy-claude-code:18897");
    expect(client.proxyUrl).toBe("http://devproxy-claude-code:18000");
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
});

describe("gateway startRecording plugin assembly", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let startSessionSpy: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.PROXY_BACKEND = "gateway";
    delete process.env.DEV_PROXY_API_URL;
    delete process.env.TOKEN_MANAGER_URL;
    delete process.env.GATEWAY_TOKEN_PLUGIN_ENABLED;
    delete process.env.GATEWAY_CAPI_HMAC_ENABLED;

    // Mock fetch to intercept startSession calls
    startSessionSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "test-session-id" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(startSessionSpy);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  function getPluginsFromCall(): Record<string, unknown> {
    const body = JSON.parse(startSessionSpy.mock.calls[0][1]?.body as string);
    return body.plugins;
  }

  it("does not include capi_hmac by default", async () => {
    const client = createProxyClient();
    await client.startRecording();
    const plugins = getPluginsFromCall();
    expect(plugins.capi_hmac).toBeUndefined();
  });

  it("opts the session in when GATEWAY_CAPI_HMAC_ENABLED=true", async () => {
    process.env.GATEWAY_CAPI_HMAC_ENABLED = "true";
    const client = createProxyClient();
    await client.startRecording();
    const plugins = getPluginsFromCall();
    expect(plugins.capi_hmac).toEqual({ enabled: true });
  });

  it("never sends HMAC credentials in session settings", async () => {
    process.env.GATEWAY_CAPI_HMAC_ENABLED = "true";
    process.env.CAPI_HMAC_SECRET = "super-secret";
    const client = createProxyClient();
    await client.startRecording();
    const body = startSessionSpy.mock.calls[0][1]?.body as string;
    expect(body).not.toContain("super-secret");
  });

  it.each(["false", "1", ""])("does not opt in when GATEWAY_CAPI_HMAC_ENABLED=%j", async (value) => {
    process.env.GATEWAY_CAPI_HMAC_ENABLED = value;
    const client = createProxyClient();
    await client.startRecording();
    const plugins = getPluginsFromCall();
    expect(plugins.capi_hmac).toBeUndefined();
  });
});
