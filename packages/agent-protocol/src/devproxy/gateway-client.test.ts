// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GatewayClient } from "./gateway-client.js";

describe("GatewayClient", () => {
  let originalEnv: NodeJS.ProcessEnv;
  const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.restoreAllMocks();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(SESSION_ID as `${string}-${string}-${string}-${string}-${string}`);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("constructor", () => {
    it("uses DEV_PROXY_API_URL env var", () => {
      process.env.DEV_PROXY_API_URL = "http://env-gateway:9999";
      const client = new GatewayClient();
      expect(client.apiUrl).toBe("http://env-gateway:9999");
    });

    it("defaults to localhost:18000", () => {
      delete process.env.DEV_PROXY_API_URL;
      const client = new GatewayClient();
      expect(client.apiUrl).toBe("http://localhost:18000");
    });

    it("exposes mcpEndpoint", () => {
      const client = new GatewayClient("http://test:18897");
      expect(client.mcpEndpoint).toBe("http://test:18897/mcp");
    });
  });

  describe("startSession", () => {
    it("calls POST /api/v1/sessions and returns session ID", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ id: SESSION_ID }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        })
      );

      const client = new GatewayClient("http://test:18897");
      const id = await client.startSession();

      expect(id).toBe(SESSION_ID);
      expect(fetchSpy).toHaveBeenCalledWith("http://test:18897/api/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: SESSION_ID, plugins: {} }),
      });
    });

    it("passes custom plugins", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ id: SESSION_ID }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        })
      );

      const client = new GatewayClient("http://test:18897");
      await client.startSession({ har: { captureHeaders: true } });

      expect(fetchSpy).toHaveBeenCalledWith("http://test:18897/api/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: SESSION_ID, plugins: { har: { captureHeaders: true } } }),
      });
    });

    it("throws on error", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValue(
          new Response("", { status: 500, statusText: "Internal Server Error" })
        );

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      await expect(client.startSession()).rejects.toThrow("Failed to create gateway session: 500");
    });

    it("retries with same session ID (idempotent)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );

      const client = new GatewayClient("http://test:18897");
      const first = await client.startSession();
      const second = await client.startSession();
      expect(first).toBe(second);
      // Both calls should use the same session ID in the body
      const firstBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
      expect(firstBody.id).toBe(secondBody.id);
    });
  });

  describe("stopSession", () => {
    it("calls POST /api/v1/sessions/:id/stop", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      await client.stopSession();

      expect(fetch).toHaveBeenCalledWith(
        `http://test:18897/api/v1/sessions/${SESSION_ID}/stop`,
        { method: "POST" },
      );
    });

    it("throws if no session started", async () => {
      const client = new GatewayClient("http://test:18897");
      await expect(client.stopSession()).rejects.toThrow("No active gateway session");
    });

    it("throws on error", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValue(
          new Response("", { status: 500, statusText: "Internal Server Error" })
        );

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      await expect(client.stopSession()).rejects.toThrow("Failed to stop gateway session: 500");
    });
  });

  describe("downloadHar", () => {
    it("returns parsed HAR on success", async () => {
      const mockHar = { log: { version: "1.2", entries: [] } };
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(mockHar), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      const result = await client.downloadHar(1);

      expect(result).toEqual(mockHar);
      expect(fetch).toHaveBeenCalledWith(
        `http://test:18897/api/v1/sessions/${SESSION_ID}/har?iteration=1`,
      );
    });

    it("returns null when no session started", async () => {
      const client = new GatewayClient("http://test:18897");
      expect(await client.downloadHar(1)).toBeNull();
    });

    it("returns null on 404", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValue(new Response("", { status: 404 }));

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      expect(await client.downloadHar(1)).toBeNull();
    });

    it("returns null on network error", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockRejectedValue(new TypeError("fetch failed"));

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      expect(await client.downloadHar(1)).toBeNull();
    });
  });

  describe("deleteSession", () => {
    it("calls DELETE /api/v1/sessions/:id", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      await client.deleteSession();

      expect(fetch).toHaveBeenCalledWith(
        `http://test:18897/api/v1/sessions/${SESSION_ID}`,
        { method: "DELETE" },
      );
    });

    it("throws if no session started", async () => {
      const client = new GatewayClient("http://test:18897");
      await expect(client.deleteSession()).rejects.toThrow("No active gateway session");
    });
  });

  describe("proxyUrl", () => {
    it("returns bare apiUrl before session is started", () => {
      const client = new GatewayClient("http://gateway:18000");
      expect(client.proxyUrl).toBe("http://gateway:18000");
    });

    it("embeds session ID as userinfo after startSession", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ id: SESSION_ID }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        })
      );

      const client = new GatewayClient("http://gateway:18000");
      await client.startSession();
      expect(client.proxyUrl).toBe(`http://${SESSION_ID}@gateway:18000`);
    });

    it("handles localhost URL", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ id: SESSION_ID }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        })
      );

      const client = new GatewayClient("http://localhost:18000");
      await client.startSession();
      expect(client.proxyUrl).toBe(`http://${SESSION_ID}@localhost:18000`);
    });

    it("reverts to bare apiUrl after deleteSession", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = new GatewayClient("http://gateway:18000");
      await client.startSession();
      expect(client.proxyUrl).toContain(SESSION_ID);
      await client.deleteSession();
      expect(client.proxyUrl).toBe("http://gateway:18000");
    });
  });

  describe("rotateHar", () => {
    it("calls POST /har/rotate with expected param and returns new iteration", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ iteration: 2 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      const newIter = await client.rotateHar(1);

      expect(newIter).toBe(2);
      expect(fetch).toHaveBeenCalledWith(
        `http://test:18897/api/v1/sessions/${SESSION_ID}/rotate?expected=1`,
        { method: "POST" },
      );
    });

    it("throws on 409 conflict when iteration jumped ahead", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValue(
          new Response(JSON.stringify({ iteration: 3 }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          })
        );

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      await expect(client.rotateHar(1)).rejects.toThrow("HAR rotate conflict");
    });

    it("treats 409 as idempotent success when iteration === expected+1", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: SESSION_ID }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ iteration: 2 }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          })
        );

      const client = new GatewayClient("http://test:18897");
      await client.startSession();
      const newIter = await client.rotateHar(1);
      expect(newIter).toBe(2);
    });

    it("throws if no session started", async () => {
      const client = new GatewayClient("http://test:18897");
      await expect(client.rotateHar(1)).rejects.toThrow("No active gateway session");
    });
  });
});
