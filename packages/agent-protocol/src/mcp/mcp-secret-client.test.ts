// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpSecretClient, McpSecretUnavailableError } from "./mcp-secret-client.js";
import type { McpSecretListItem } from "./mcp-secret-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const BASE_URL = "https://token-manager.dev";

function makeSecretItem(overrides: Partial<McpSecretListItem> = {}): McpSecretListItem {
  return {
    id: "abc123",
    mcpId: "test-server",
    name: "MY_SECRET",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : "Error",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

describe("McpSecretClient", () => {
  let client: McpSecretClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new McpSecretClient(BASE_URL);
  });

  it("strips trailing slashes from the Token Manager URL", async () => {
    const c = new McpSecretClient(`${BASE_URL}///`);
    mockFetch.mockResolvedValueOnce(jsonResponse(makeSecretItem()));

    await c.storeSecret("srv", "KEY", "val");

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/mcp/servers/srv/secrets`,
      expect.objectContaining({ method: "POST" })
    );
  });

  describe("storeSecret()", () => {
    it("sends POST with name and value", async () => {
      const item = makeSecretItem({ mcpId: "my-srv", name: "API_KEY" });
      mockFetch.mockResolvedValueOnce(jsonResponse(item));

      const result = await client.storeSecret("my-srv", "API_KEY", "secret-value");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my-srv/secrets`,
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "API_KEY", value: "secret-value" }),
        })
      );
      expect(result).toEqual(item);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      await expect(client.storeSecret("srv", "KEY", "val")).rejects.toThrow(
        /POST .* failed: 500/
      );
    });

    it("URL-encodes the mcpId", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(makeSecretItem()));

      await client.storeSecret("my/server", "KEY", "val");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my%2Fserver/secrets`,
        expect.any(Object)
      );
    });
  });

  describe("storeEnv()", () => {
    it("stores each env pair sequentially", async () => {
      const item1 = makeSecretItem({ name: "A" });
      const item2 = makeSecretItem({ name: "B" });
      mockFetch
        .mockResolvedValueOnce(jsonResponse(item1))
        .mockResolvedValueOnce(jsonResponse(item2));

      const results = await client.storeEnv("srv", { A: "1", B: "2" });

      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("storeHeaders()", () => {
    it("stores each header sequentially", async () => {
      const item1 = makeSecretItem({ name: "Authorization" });
      const item2 = makeSecretItem({ name: "X-Custom" });
      mockFetch
        .mockResolvedValueOnce(jsonResponse(item1))
        .mockResolvedValueOnce(jsonResponse(item2));

      const results = await client.storeHeaders("srv", [
        { name: "Authorization", value: "Bearer tok" },
        { name: "X-Custom", value: "val" },
      ]);

      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("listSecrets()", () => {
    it("returns secret metadata array", async () => {
      const items = [makeSecretItem({ name: "A" }), makeSecretItem({ name: "B" })];
      mockFetch.mockResolvedValueOnce(jsonResponse(items));

      const result = await client.listSecrets("my-srv");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my-srv/secrets`,
        undefined
      );
      expect(result).toEqual(items);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      await expect(client.listSecrets("srv")).rejects.toThrow(/GET .* failed: 500/);
    });
  });

  describe("resolveSecrets()", () => {
    it("returns env map for stdio servers", async () => {
      const resolved = { env: { API_KEY: "secret" } };
      mockFetch.mockResolvedValueOnce(jsonResponse(resolved));

      const result = await client.resolveSecrets("my-srv");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my-srv/secrets/resolve`,
        undefined
      );
      expect(result).toEqual(resolved);
    });

    it("returns headers array for http servers", async () => {
      const resolved = { headers: [{ name: "Authorization", value: "Bearer tok" }] };
      mockFetch.mockResolvedValueOnce(jsonResponse(resolved));

      const result = await client.resolveSecrets("my-srv");
      expect(result).toEqual(resolved);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 403));

      await expect(client.resolveSecrets("srv")).rejects.toThrow(/GET .* failed: 403/);
    });
  });

  describe("deleteSecret()", () => {
    it("sends DELETE to the correct URL", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));

      await client.deleteSecret("my-srv", "API_KEY");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my-srv/secrets/API_KEY`,
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("treats 404 as success (idempotent)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

      await expect(client.deleteSecret("srv", "MISSING")).resolves.toBeUndefined();
    });

    it("throws on non-404 error", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      await expect(client.deleteSecret("srv", "KEY")).rejects.toThrow(
        /DELETE .* failed: 500/
      );
    });

    it("URL-encodes the secret name", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));

      await client.deleteSecret("srv", "my/key");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/srv/secrets/my%2Fkey`,
        expect.any(Object)
      );
    });
  });

  describe("deleteAllSecrets()", () => {
    it("lists then deletes each secret", async () => {
      const items = [makeSecretItem({ name: "A" }), makeSecretItem({ name: "B" })];
      mockFetch
        .mockResolvedValueOnce(jsonResponse(items))    // listSecrets
        .mockResolvedValueOnce(jsonResponse({}, 200))  // delete A
        .mockResolvedValueOnce(jsonResponse({}, 200)); // delete B

      await client.deleteAllSecrets("srv");

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("swallows list error gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));

      // deleteAllSecrets catches the list error and returns empty
      // But fetchOrThrow wraps network errors as McpSecretUnavailableError
      // and listSecrets.catch() swallows it — so no deletions happen
      await expect(client.deleteAllSecrets("srv")).resolves.toBeUndefined();
    });
  });

  describe("McpSecretUnavailableError", () => {
    it("wraps network errors with descriptive message", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(client.listSecrets("srv")).rejects.toThrow(McpSecretUnavailableError);

      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(client.listSecrets("srv")).rejects.toThrow(/Token Manager is unreachable/);
    });

    it("wraps non-Error causes", async () => {
      mockFetch.mockRejectedValueOnce("string error");

      await expect(client.storeSecret("srv", "KEY", "val")).rejects.toThrow(
        /Token Manager is unreachable.*string error/
      );
    });
  });
});
