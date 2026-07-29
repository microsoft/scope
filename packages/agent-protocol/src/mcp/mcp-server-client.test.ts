// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServerClient } from "./mcp-server-client.js";
import type { McpServerDocument, McpServerConfig } from "@scope/core";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeServerDoc(overrides: Partial<McpServerDocument> = {}): McpServerDocument {
  return {
    _id: "test-server",
    name: "Test Server",
    type: "http",
    url: "https://example.com/mcp",
    createdAt: new Date("2025-01-01"),
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : "Error",
    json: () => Promise.resolve(data),
  } as Response;
}

describe("McpServerClient", () => {
  let client: McpServerClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new McpServerClient("https://api.scope-mt.dev");
  });

  it("strips trailing slashes from the API URL", async () => {
    const c = new McpServerClient("https://api.scope-mt.dev///");
    mockFetch.mockResolvedValueOnce(jsonResponse(makeServerDoc()));

    await c.resolveServers(["test-server"]);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.scope-mt.dev/api/v1/mcp/servers/test-server"
    );
  });

  it("returns empty array for empty slugs", async () => {
    const result = await client.resolveServers([]);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolves a single server slug", async () => {
    const doc = makeServerDoc({
      _id: "my-search",
      name: "My Search",
      type: "sse",
      url: "https://search.example.com/sse",
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(doc));

    const result = await client.resolveServers(["my-search"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "sse",
      slug: "my-search",
      name: "My Search",
      url: "https://search.example.com/sse",
    } satisfies McpServerConfig);
  });

  it("resolves multiple server slugs", async () => {
    const doc1 = makeServerDoc({ _id: "server-a", name: "Server A", type: "http", url: "https://a.com/mcp" });
    const doc2 = makeServerDoc({ _id: "server-b", name: "Server B", type: "sse", url: "https://b.com/sse" });
    mockFetch
      .mockResolvedValueOnce(jsonResponse(doc1))
      .mockResolvedValueOnce(jsonResponse(doc2));

    const result = await client.resolveServers(["server-a", "server-b"]);

    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe("server-a");
    expect(result[0].name).toBe("Server A");
    expect(result[1].slug).toBe("server-b");
    expect(result[1].name).toBe("Server B");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("includes headers when present", async () => {
    const doc = makeServerDoc({
      headers: [
        { name: "Authorization", value: "Bearer token" },
        { name: "X-Custom", value: "val" },
      ],
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(doc));

    const result = await client.resolveServers(["test-server"]);

    expect(result[0].headers).toEqual([
      { name: "Authorization", value: "Bearer token" },
      { name: "X-Custom", value: "val" },
    ]);
  });

  it("omits headers when empty array", async () => {
    const doc = makeServerDoc({ headers: [] });
    mockFetch.mockResolvedValueOnce(jsonResponse(doc));

    const result = await client.resolveServers(["test-server"]);

    expect(result[0].headers).toBeUndefined();
  });

  it("strips DB metadata from config (no createdAt, updatedAt, etc.) and maps _id to slug", async () => {
    const doc = makeServerDoc({
      _id: "db-server",
      createdAt: new Date(),
      updatedAt: new Date(),
      description: "Some description",
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(doc));

    const result = await client.resolveServers(["db-server"]);
    const config = result[0];

    expect(config.slug).toBe("db-server");
    expect((config as any)._id).toBeUndefined();
    expect(config.slug).toBe("db-server");
    expect((config as any).createdAt).toBeUndefined();
    expect((config as any).updatedAt).toBeUndefined();
    expect((config as any).deletedAt).toBeUndefined();
    expect((config as any).description).toBeUndefined();
  });

  it("throws on 404 (server not found)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

    await expect(client.resolveServers(["missing-server"])).rejects.toThrow(
      "MCP server 'missing-server' not found via API"
    );
  });

  it("throws on non-OK HTTP status", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({}),
    } as Response);

    await expect(client.resolveServers(["broken"])).rejects.toThrow(
      /GET .* failed: 500 Internal Server Error/
    );
  });

  it("URL-encodes special characters in slugs", async () => {
    const doc = makeServerDoc({ _id: "server/special" });
    mockFetch.mockResolvedValueOnce(jsonResponse(doc));

    await client.resolveServers(["server/special"]);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.scope-mt.dev/api/v1/mcp/servers/server%2Fspecial"
    );
  });

  it("maps display name with spaces to gateway-safe slug (regression: MS Learn)", async () => {
    const doc = makeServerDoc({ _id: "ms-learn", name: "MS Learn", type: "http", url: "https://learn.microsoft.com/mcp" });
    mockFetch.mockResolvedValueOnce(jsonResponse(doc));

    const result = await client.resolveServers(["ms-learn"]);

    expect(result[0].slug).toBe("ms-learn");
    expect(result[0].name).toBe("MS Learn");
  });

  it("fails fast on first error in multiple slugs", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

    await expect(
      client.resolveServers(["missing", "also-missing"])
    ).rejects.toThrow("MCP server 'missing' not found via API");

    // Second slug was never fetched
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
