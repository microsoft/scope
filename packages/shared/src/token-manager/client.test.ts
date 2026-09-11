// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenManagerClient } from "./client.js";

describe("TokenManagerClient", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  describe("Portal AI selection", () => {
    it("reads the persisted Portal-only settings without reading provider env", async () => {
      process.env.ANTHROPIC_API_KEY = "env-key";
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
        provider: "anthropic", keyId: "saved-key", model: "claude-model",
      })));
      expect(await new TokenManagerClient("http://tm.test").getPortalAiSettings())
        .toEqual({ provider: "anthropic", keyId: "saved-key", model: "claude-model" });
      expect(spy).toHaveBeenCalledWith("http://tm.test/api/v1/keys/portal-ai", expect.objectContaining({ method: "GET" }));
    });
    it("forwards strict type and key selection instead of taking an unrelated env key", async () => {
      process.env.ANTHROPIC_API_KEY = "env-key";
      const response = { value: "stored-key", keyId: "saved-key", keyType: "anthropic-api-key", capability: "anthropic-api" };
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(response)));
      const request = { capability: "anthropic-api", keyType: "anthropic-api-key", strictKeyType: true, keyId: "saved-key" } as const;
      expect(await new TokenManagerClient("http://tm.test").acquirePortalToken(request)).toEqual(response);
      expect(spy).toHaveBeenCalledWith("http://tm.test/api/v1/keys/acquire", expect.objectContaining({ body: JSON.stringify(request) }));
    });
    it("does not retry missing credentials", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no key", { status: 404 }));
      await expect(new TokenManagerClient("http://tm.test").acquirePortalToken({ capability: "openai-api" })).rejects.toThrow("HTTP 404");
      expect(spy).toHaveBeenCalledOnce();
    });
    it("rejects an upstream that ignores a pinned key instead of silently switching credentials", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
        value: "wrong-key", keyId: "other-key", keyType: "openai-api-key", capability: "openai-api",
      })));
      await expect(new TokenManagerClient("http://tm.test").acquirePortalToken({
        capability: "openai-api", keyType: "openai-api-key", strictKeyType: true, keyId: "selected-key",
      })).rejects.toThrow("did not honor");
    });
    it("retries transient Token Manager failures once before returning settings", async () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(new Response('{"provider":"auto"}'));
      const result = new TokenManagerClient("http://tm.test").getPortalAiSettings();
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ provider: "auto" });
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe("acquireToken - env var fallback", () => {
    it("returns GITHUB_TOKEN env var for copilot-sdk capability", async () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("copilot-sdk");

      expect(result).toBe("ghp_test123");
    });

    it("returns ANTHROPIC_API_KEY env var for claude-code-cli capability", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test456";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("claude-code-cli");

      expect(result).toBe("sk-ant-test456");
    });

    it("returns GITHUB_TOKEN env var for github-models capability", async () => {
      process.env.GITHUB_TOKEN = "ghp_models_789";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("github-models");

      expect(result).toBe("ghp_models_789");
    });
    it("returns GITHUB_TOKEN env var for copilot-cli capability", async () => {
      process.env.GITHUB_TOKEN = "ghp_cli_test";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("copilot-cli");

      expect(result).toBe("ghp_cli_test");
    });

    it("returns GITHUB_TOKEN env var for copilot-models capability", async () => {
      process.env.GITHUB_TOKEN = "ghp_copilot_models_test";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("copilot-models");

      expect(result).toBe("ghp_copilot_models_test");
    });

    it("does not make HTTP call when env var is set", async () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const client = new TokenManagerClient("http://localhost:3000");

      await client.acquireToken("copilot-sdk");

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("acquireToken - API call", () => {
    it("calls Token Manager API when env var is not set", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: true,
        json: async () => ({
          value: "ghp_from_api",
          keyId: "abc-123",
          capability: "copilot-sdk",
        }),
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");
      const result = await client.acquireToken("copilot-sdk");

      expect(result).toBe("ghp_from_api");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://token-manager:80/api/v1/keys/acquire",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capability: "copilot-sdk" }),
        })
      );
    });

    it("strips trailing slash from base URL", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: true,
        json: async () => ({ value: "ghp_test", keyId: "x", capability: "copilot-sdk" }),
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80///");
      await client.acquireToken("copilot-sdk");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://token-manager:80/api/v1/keys/acquire",
        expect.anything()
      );
    });

    it("uses TOKEN_MANAGER_URL env var when no baseUrl provided", async () => {
      delete process.env.GITHUB_TOKEN;
      process.env.TOKEN_MANAGER_URL = "http://tm-from-env:80";
      const mockResponse = {
        ok: true,
        json: async () => ({ value: "ghp_env", keyId: "x", capability: "copilot-sdk" }),
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient();
      await client.acquireToken("copilot-sdk");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://tm-from-env:80/api/v1/keys/acquire",
        expect.anything()
      );
    });
  });

  describe("acquireToken - error handling", () => {
    it("throws when API returns 404 (no tokens available)", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: false,
        status: 404,
        text: async () => "No valid tokens available for capability 'copilot-sdk'",
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");

      await expect(client.acquireToken("copilot-sdk")).rejects.toThrow(
        /Key acquisition failed.*copilot-sdk.*404/
      );
    });

    it("throws when API returns 500", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");

      await expect(client.acquireToken("copilot-sdk")).rejects.toThrow(
        /Key acquisition failed.*copilot-sdk.*500/
      );
    });

    it("throws when response has no value", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: true,
        json: async () => ({ keyId: "x", capability: "copilot-sdk" }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");

      await expect(client.acquireToken("copilot-sdk")).rejects.toThrow(
        /Invalid key response.*copilot-sdk.*no value/
      );
    });

    it("throws when no env var and no base URL configured", async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.TOKEN_MANAGER_URL;

      const client = new TokenManagerClient();

      await expect(client.acquireToken("copilot-sdk")).rejects.toThrow(
        /No key available.*copilot-sdk.*GITHUB_TOKEN.*TOKEN_MANAGER_URL/
      );
    });
  });
});
