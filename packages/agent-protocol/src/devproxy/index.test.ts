// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    process.env.DEV_PROXY_API_URL = "http://devproxy-copilot:18897";
    process.env.DEV_PROXY_URL = "http://devproxy-copilot:18000";
    const client = createProxyClient();
    expect(client.backend).toBe("devproxy");
    expect(client.apiUrl).toBe("http://devproxy-copilot:18897");
    expect(client.proxyUrl).toBe("http://devproxy-copilot:18000");
  });

  it("never returns the management API URL as the proxy URL", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-copilot:18897";
    process.env.DEV_PROXY_URL = "http://devproxy-copilot:18000";
    const client = createProxyClient();
    // Regression guard for the bug that caused
    // "-32000 Authentication required" in the copilot worker: the worker
    // was setting HTTP_PROXY to the API port (18897), making every HTTPS
    // request fail.
    expect(client.proxyUrl).not.toBe(client.apiUrl);
    expect(client.proxyUrl).not.toContain(":18897");
  });

  it("throws when DEV_PROXY_URL is missing", () => {
    process.env.DEV_PROXY_API_URL = "http://devproxy-copilot:18897";
    expect(() => createProxyClient()).toThrowError(/DEV_PROXY_URL must be set/);
  });
});
