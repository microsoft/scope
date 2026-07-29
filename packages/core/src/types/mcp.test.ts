// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import type { McpServerDocument, McpServerConfig, McpTransportType, McpServerHeader } from "./mcp.js";

describe("McpServerDocument", () => {
  it("supports all required fields for an HTTP server", () => {
    const server: McpServerDocument = {
      _id: "my-search",
      name: "My Search Server",
      type: "http",
      url: "https://search.example.com/mcp",
      createdAt: new Date(),
    };

    expect(server._id).toBe("my-search");
    expect(server.name).toBe("My Search Server");
    expect(server.type).toBe("http");
    expect(server.url).toBe("https://search.example.com/mcp");
    expect(server.headers).toBeUndefined();
    expect(server.description).toBeUndefined();
    expect(server.deletedAt).toBeUndefined();
  });

  it("supports SSE type with headers", () => {
    const server: McpServerDocument = {
      _id: "auth-search",
      name: "Authenticated Search",
      type: "sse",
      url: "https://search.example.com/sse",
      headers: [
        { name: "Authorization", value: "Bearer token123" },
        { name: "X-Api-Key", value: "key456" },
      ],
      description: "Search server with auth",
      createdAt: new Date(),
    };

    expect(server.type).toBe("sse");
    expect(server.headers).toHaveLength(2);
    expect(server.headers![0].name).toBe("Authorization");
    expect(server.description).toBe("Search server with auth");
  });

  it("supports soft-delete with deletedAt", () => {
    const server: McpServerDocument = {
      _id: "old-server",
      name: "Old Server",
      type: "http",
      url: "https://old.example.com/mcp",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-06-01"),
      deletedAt: new Date("2025-06-15"),
    };

    expect(server.deletedAt).toBeInstanceOf(Date);
    expect(server.updatedAt).toBeInstanceOf(Date);
  });
});

describe("McpServerConfig", () => {
  it("contains only runtime fields (no DB metadata)", () => {
    const config: McpServerConfig = {
      type: "http",
      slug: "my-server",
      name: "My Server",
      url: "https://example.com/mcp",
    };

    expect(config.type).toBe("http");
    expect(config.name).toBe("My Server");
    expect(config.url).toBe("https://example.com/mcp");
    expect(config.headers).toBeUndefined();
    // Verify no DB metadata fields exist on the type
    expect((config as any)._id).toBeUndefined();
    expect((config as any).createdAt).toBeUndefined();
    expect((config as any).deletedAt).toBeUndefined();
  });

  it("supports headers", () => {
    const config: McpServerConfig = {
      type: "sse",
      slug: "auth-server",
      name: "Auth Server",
      url: "https://example.com/sse",
      headers: [{ name: "Authorization", value: "Bearer abc" }],
    };

    expect(config.headers).toHaveLength(1);
    expect(config.headers![0]).toEqual({ name: "Authorization", value: "Bearer abc" });
  });
});

describe("McpTransportType", () => {
  it("accepts valid transport types", () => {
    const types: McpTransportType[] = ["sse", "http"];
    expect(types).toHaveLength(2);
    expect(types).toContain("sse");
    expect(types).toContain("http");
  });
});

describe("McpServerHeader", () => {
  it("has name and value fields", () => {
    const header: McpServerHeader = { name: "Content-Type", value: "application/json" };
    expect(header.name).toBe("Content-Type");
    expect(header.value).toBe("application/json");
  });
});
