// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpGatewayClient } from "./mcp-gateway-client.js";
import type { McpServerConfig } from "@scope/core";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okResponse(data: unknown = null, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

function errorResponse(status: number, body = "Error"): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(body),
  } as Response;
}

describe("McpGatewayClient", () => {
  let client: McpGatewayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new McpGatewayClient("http://localhost:8080");
  });

  afterEach(() => {
    delete process.env.MCP_GATEWAY_URL;
  });

  describe("constructor / mcpEndpoint", () => {
    it("strips trailing slashes from base URL", () => {
      const c = new McpGatewayClient("http://localhost:8080///");
      expect(c.mcpEndpoint).toBe("http://localhost:8080/mcp");
    });

    it("falls back to MCP_GATEWAY_URL env var", () => {
      process.env.MCP_GATEWAY_URL = "http://gateway:9090";
      const c = new McpGatewayClient();
      expect(c.mcpEndpoint).toBe("http://gateway:9090/mcp");
    });

    it("falls back to localhost:8080 when no arg and no env", () => {
      const c = new McpGatewayClient();
      expect(c.mcpEndpoint).toBe("http://localhost:8080/mcp");
    });
  });

  describe("isEnabled()", () => {
    it("returns false when MCP_GATEWAY_URL is not set", () => {
      expect(McpGatewayClient.isEnabled()).toBe(false);
    });

    it("returns true when MCP_GATEWAY_URL is set", () => {
      process.env.MCP_GATEWAY_URL = "http://gateway:8080";
      expect(McpGatewayClient.isEnabled()).toBe(true);
    });
  });

  describe("listServers()", () => {
    it("returns server names from the gateway", async () => {
      mockFetch.mockResolvedValueOnce(
        okResponse([{ name: "context7" }, { name: "filesystem" }])
      );

      const result = await client.listServers();

      expect(result).toEqual(["context7", "filesystem"]);
      expect(mockFetch).toHaveBeenCalledWith("http://localhost:8080/api/v0/servers");
    });

    it("returns empty array when no servers registered", async () => {
      mockFetch.mockResolvedValueOnce(okResponse([]));
      const result = await client.listServers();
      expect(result).toEqual([]);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500));
      await expect(client.listServers()).rejects.toThrow(
        "[McpGatewayClient] GET /api/v0/servers failed: 500"
      );
    });
  });

  describe("registerServer()", () => {
    it("registers an HTTP server with correct transport mapping", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      const config: McpServerConfig = {
        slug: "my-server",
        name: "my-server",
        type: "http",
        url: "https://example.com/mcp",
      };
      await client.registerServer(config);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/v0/servers?force=true",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "my-server",
            transport: "streamable_http",
            url: "https://example.com/mcp",
            session_mode: "stateless",
          }),
        })
      );
    });

    it("uses slug (not display name) so spaces in name don't cause gateway rejection", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await client.registerServer({ slug: "ms-learn", name: "MS Learn", type: "http", url: "https://learn.microsoft.com/mcp" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.name).toBe("ms-learn");
    });

    it("registers an SSE server with correct transport mapping", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await client.registerServer({ slug: "sse-srv", name: "sse-srv", type: "sse", url: "https://example.com/sse" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.transport).toBe("sse");
    });

    it("registers a stdio server with command, args, and env", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      const config: McpServerConfig = {
        slug: "fs-server",
        name: "fs-server",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        env: { HOME: "/root" },
      };
      await client.registerServer(config);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        name: "fs-server",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        env: { HOME: "/root" },
        session_mode: "stateful",
      });
    });

    it("omits env from stdio body when empty", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await client.registerServer({ slug: "fs", name: "fs", type: "stdio", command: "npx", args: [] });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("env");
    });

    it("includes headers for HTTP servers when provided", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await client.registerServer({
        slug: "auth-srv",
        name: "auth-srv",
        type: "http",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer token" }],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.headers).toEqual({ Authorization: "Bearer token" });
    });

    it("omits headers from body when empty array", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await client.registerServer({ slug: "srv", name: "srv", type: "http", url: "https://example.com/mcp", headers: [] });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("headers");
    });

    it("uses custom sessionMode when provided", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await client.registerServer({
        slug: "srv",
        name: "srv",
        type: "http",
        url: "https://example.com/mcp",
        sessionMode: "stateful",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.session_mode).toBe("stateful");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(400, "bad request"));
      await expect(
        client.registerServer({ slug: "srv", name: "srv", type: "http", url: "https://example.com/mcp" })
      ).rejects.toThrow("[McpGatewayClient] POST /api/v0/servers failed: 400");
    });
  });

  describe("deregisterServer()", () => {
    it("sends DELETE to the correct URL", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await client.deregisterServer("context7");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/v0/servers/context7",
        { method: "DELETE" }
      );
    });

    it("URL-encodes server names with special characters", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await client.deregisterServer("my server/v2");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/v0/servers/my%20server%2Fv2",
        { method: "DELETE" }
      );
    });

    it("treats 404 as success (idempotent)", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404));
      await expect(client.deregisterServer("missing")).resolves.toBeUndefined();
    });

    it("throws on non-404 error responses", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500));
      await expect(client.deregisterServer("srv")).rejects.toThrow(
        "[McpGatewayClient] DELETE /api/v0/servers/srv failed: 500"
      );
    });
  });

  describe("purgeAll()", () => {
    it("deregisters all servers returned by listServers", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse([{ name: "context7" }, { name: "filesystem" }]))
        .mockResolvedValueOnce(okResponse()) // DELETE context7
        .mockResolvedValueOnce(okResponse()); // DELETE filesystem

      await client.purgeAll();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/v0/servers/context7",
        { method: "DELETE" }
      );
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/v0/servers/filesystem",
        { method: "DELETE" }
      );
    });

    it("is a no-op when no servers are registered", async () => {
      mockFetch.mockResolvedValueOnce(okResponse([]));
      await client.purgeAll();
      expect(mockFetch).toHaveBeenCalledTimes(1); // only the listServers call
    });
  });
});
