// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpServer,
  readJsonBody,
  MAX_BODY_BYTES,
  type HttpServerOptions,
  type NotifyHandler,
} from "./notify-routes.js";

async function startServer(
  handler: NotifyHandler,
  options?: HttpServerOptions,
): Promise<{ server: ReturnType<typeof createHttpServer>; baseUrl: string }> {
  const server = createHttpServer(handler, options);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to an address");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
  };
}

async function stopServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("createHttpServer", () => {
  const servers: Array<ReturnType<typeof createHttpServer>> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await stopServer(server);
      }
    }
  });

  it("returns 200 for the health endpoint", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "scheduler" });
  });

  it("calls onRunTerminal for valid run-terminal notifications", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/notify/run-terminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-1", runId: "run-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handler.onRunTerminal).toHaveBeenCalledWith("req-1", "run-1");
    expect(handler.onHandlerComplete).not.toHaveBeenCalled();
  });

  it("calls onHandlerComplete for valid handler-complete notifications", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/notify/handler-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-1",
        runId: "run-1",
        handlerId: "atif",
        status: "done",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handler.onHandlerComplete).toHaveBeenCalledWith("req-1", "run-1", "atif", "done");
    expect(handler.onRunTerminal).not.toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/notify/handler-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-1", runId: "run-1", status: "done" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "requestId, runId, handlerId, and status (done|failed) are required",
    });
    expect(handler.onRunTerminal).not.toHaveBeenCalled();
    expect(handler.onHandlerComplete).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown routes", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/notify/unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("calls registerHandler for valid handler registrations", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const doc = {
      _id: "pp-example",
      type: "post-process-handler",
      version: 1,
      queue: "pp-example-queue",
      selector: "example",
      autoBackfill: false,
      dependsOn: ["pp-atif"],
    };

    const response = await fetch(`${baseUrl}/handlers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, handlerId: "pp-example" });
    expect(handler.registerHandler).toHaveBeenCalledWith(doc);
  });

  it("returns 400 for invalid handler registrations", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/handlers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Missing queue/selector, wrong type, dependsOn not array
      body: JSON.stringify({ _id: "bad", type: "wrong", version: "x" }),
    });

    expect(response.status).toBe(400);
    expect(handler.registerHandler).not.toHaveBeenCalled();
  });

  it("returns 413 and does not invoke the handler when the body exceeds the cap", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    // Tiny cap so a small, deterministic payload trips it (no socket-buffer race).
    const { server, baseUrl } = await startServer(handler, { maxBodyBytes: 32 });
    servers.push(server);

    const response = await fetch(`${baseUrl}/notify/run-terminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "r".repeat(100), runId: "run-1" }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
    expect(handler.onRunTerminal).not.toHaveBeenCalled();
  });
});

describe("readJsonBody", () => {
  /** Build a mock IncomingMessage backed by a PassThrough with the given headers. */
  function mockReq(headers: Record<string, string> = {}): IncomingMessage & PassThrough {
    const req = new PassThrough() as PassThrough & { headers: Record<string, string> };
    req.headers = headers;
    return req as unknown as IncomingMessage & PassThrough;
  }

  it("parses a valid JSON body under the cap", async () => {
    const req = mockReq();
    const promise = readJsonBody(req, 1024);
    req.end(JSON.stringify({ hello: "world" }));

    await expect(promise).resolves.toEqual({ hello: "world" });
  });

  it("rejects a declared Content-Length over the cap without reading the body", async () => {
    const req = mockReq({ "content-length": "5000" });
    const onData = vi.fn();
    req.on("data", onData);

    await expect(readJsonBody(req, 1024)).rejects.toThrow(/limit/);
    expect(onData).not.toHaveBeenCalled(); // fast-path rejects before consuming
  });

  it("rejects a chunked body that streams past the cap (no Content-Length)", async () => {
    const req = mockReq(); // no content-length → exercises the streaming guard
    const promise = readJsonBody(req, 16);
    req.write("x".repeat(10));
    req.write("x".repeat(10)); // total 20 > 16
    req.end();

    await expect(promise).rejects.toThrow(/limit/);
  });

  it("rejects an empty body", async () => {
    const req = mockReq();
    const promise = readJsonBody(req, 1024);
    req.end("");

    await expect(promise).rejects.toThrow("Request body is required");
  });

  it("defaults the cap to MAX_BODY_BYTES (64 KB)", async () => {
    const req = mockReq({ "content-length": String(MAX_BODY_BYTES + 1) });

    await expect(readJsonBody(req)).rejects.toThrow(/limit/);
  });
});
