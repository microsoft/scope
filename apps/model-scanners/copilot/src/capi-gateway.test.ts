// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { writeFile } from "node:fs/promises";
import { describe, it, expect, vi, beforeEach } from "vitest";

const gateway = vi.hoisted(() => ({
  instances: [] as unknown[],
  waitForReady: vi.fn(),
  downloadCertificate: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn(),
  deleteSession: vi.fn(),
}));

const undici = vi.hoisted(() => ({
  agents: [] as Array<{ opts: Record<string, unknown>; close: ReturnType<typeof vi.fn> }>,
  fetch: vi.fn(),
}));

vi.mock("shared", () => ({
  GatewayClient: vi.fn().mockImplementation(function (url: string) {
    const client = {
      url,
      waitForReady: gateway.waitForReady,
      downloadCertificate: gateway.downloadCertificate,
      startSession: gateway.startSession,
      stopSession: gateway.stopSession,
      deleteSession: gateway.deleteSession,
    };
    gateway.instances.push(client);
    return client;
  }),
}));

vi.mock("undici", () => ({
  fetch: undici.fetch,
  ProxyAgent: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    const agent = { opts, close: vi.fn().mockResolvedValue(undefined) };
    undici.agents.push(agent);
    return agent;
  }),
}));

import {
  isCapiHmacEnabled,
  proxyAuthorizationFor,
  withCapiGatewayFetch,
} from "./capi-gateway.js";

describe("isCapiHmacEnabled", () => {
  it("is true only for the exact string 'true'", () => {
    expect(isCapiHmacEnabled({ GATEWAY_CAPI_HMAC_ENABLED: "true" })).toBe(true);
    expect(isCapiHmacEnabled({ GATEWAY_CAPI_HMAC_ENABLED: "1" })).toBe(false);
    expect(isCapiHmacEnabled({ GATEWAY_CAPI_HMAC_ENABLED: "false" })).toBe(false);
    expect(isCapiHmacEnabled({})).toBe(false);
  });
});

describe("proxyAuthorizationFor", () => {
  it("encodes the session id as Basic username with empty password", () => {
    const header = proxyAuthorizationFor("sess-123");
    expect(header).toBe(`Basic ${Buffer.from("sess-123:").toString("base64")}`);
  });
});

describe("withCapiGatewayFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateway.instances.length = 0;
    undici.agents.length = 0;
    gateway.waitForReady.mockResolvedValue(undefined);
    gateway.downloadCertificate.mockImplementation((path: string) =>
      writeFile(path, "-----BEGIN CERTIFICATE-----\ngateway\n-----END CERTIFICATE-----\n"),
    );
    gateway.startSession.mockResolvedValue("sess-abc");
    gateway.stopSession.mockResolvedValue(undefined);
    gateway.deleteSession.mockResolvedValue(undefined);
    undici.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  it("throws when no gateway URL is configured", async () => {
    await expect(withCapiGatewayFetch(async () => 1, "")).rejects.toThrow(
      /DEV_PROXY_API_URL/,
    );
    expect(gateway.instances).toHaveLength(0);
  });

  it("opts the session into capi_hmac and proxies fetch through it", async () => {
    const result = await withCapiGatewayFetch(async (fetchFn) => {
      await fetchFn("https://api.githubcopilot.com/models", {
        headers: { "Copilot-Integration-Id": "vscode-chat" },
      });
      return "ok";
    }, "http://gateway:8080");

    expect(result).toBe("ok");
    expect(gateway.startSession).toHaveBeenCalledWith(
      { capi_hmac: { enabled: true }, har: { enabled: false } },
      300,
    );

    expect(undici.agents).toHaveLength(1);
    const { opts } = undici.agents[0];
    expect(opts.uri).toBe("http://gateway:8080");
    expect(opts.token).toBe(proxyAuthorizationFor("sess-abc"));
    const ca = (opts.requestTls as { ca: string[] }).ca;
    expect(ca.some((c) => c.includes("gateway"))).toBe(true);

    const [url, init] = undici.fetch.mock.calls[0];
    expect(url).toBe("https://api.githubcopilot.com/models");
    expect(init.dispatcher).toBe(undici.agents[0]);
    expect(init.headers).toEqual({ "Copilot-Integration-Id": "vscode-chat" });

    expect(undici.agents[0].close).toHaveBeenCalled();
    expect(gateway.stopSession).toHaveBeenCalled();
    expect(gateway.deleteSession).toHaveBeenCalled();
  });

  it("cleans up the session when the callback throws", async () => {
    await expect(
      withCapiGatewayFetch(async () => {
        throw new Error("boom");
      }, "http://gateway:8080"),
    ).rejects.toThrow("boom");

    expect(undici.agents[0].close).toHaveBeenCalled();
    expect(gateway.stopSession).toHaveBeenCalled();
    expect(gateway.deleteSession).toHaveBeenCalled();
  });

  it("still returns the result when session cleanup fails", async () => {
    gateway.stopSession.mockRejectedValue(new Error("gateway gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      withCapiGatewayFetch(async () => "done", "http://gateway:8080"),
    ).resolves.toBe("done");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gateway gone"));
  });
});
