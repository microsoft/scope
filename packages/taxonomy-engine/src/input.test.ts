// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { loadJson } from "./input.js";
const servers: Server[] = [];

// Each test owns a loopback server; force-close connections so timeout scenarios cannot leak handles.
afterEach(async () => {
  for (const server of servers) await new Promise<void>((resolve, reject) => {
    server.close(e => e ? reject(e) : resolve());
    server.closeAllConnections();
  });
  servers.length = 0;
});

/**
 * Starts a bounded loopback fixture.
 *
 * @param handler - Node HTTP handler implementing the acquisition scenario.
 * @returns Loopback HTTP base URL.
 */
async function serve(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return `http://127.0.0.1:${address.port}`;
}
it("bounds redirects, retries, bytes and time; never sends a token or follows embedded content", async () => {
  let count = 0;
  const base = await serve((req, res) => {
    // One handler exposes every acquisition branch while asserting credentials never cross the boundary.
    expect(req.headers.authorization).toBeUndefined();
    if (req.url === "/retry" && count++ === 0) {
      res.writeHead(503).end();
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/data" }).end();
      return;
    }
    if (req.url === "/loop") {
      res.writeHead(302, { Location: "/loop" }).end();
      return;
    }
    if (req.url === "/large") {
      res.end("x".repeat(100));
      return;
    }
    if (req.url === "/slow") return;
    res.setHeader("Content-Type", "application/json");
    res.end('{"embedded_url":"http://must-not-fetch.invalid"}');
  });
  expect(await loadJson(`${base}/retry`)).toHaveProperty("embedded_url");
  expect(count).toBe(2);
  expect(await loadJson(`${base}/redirect`)).toHaveProperty("embedded_url");
  await expect(loadJson(`${base}/loop`)).rejects.toThrow("redirect limit");
  await expect(loadJson(`${base}/large`, { maxBytes: 10 })).rejects.toThrow("exceeds");
  await expect(loadJson(`${base}/slow`, { timeoutMs: 10, attempts: 1 })).rejects.toThrow("bounded network");
  await expect(loadJson("ftp://example.invalid/atif")).rejects.toThrow("HTTP(S)");
});
it("does not retry permanent errors and redacts URL query strings in errors", async () => {
  let count = 0;
  const base = await serve((_req, res) => {
    count++;
    res.writeHead(403).end();
  });
  await expect(loadJson(`${base}/private?secret=never-log`)).rejects.toThrow("HTTP 403");
  expect(count).toBe(1);
});
it("retries failed redirect targets and truncated response bodies within the same bounded layer", async () => {
  let targetHits = 0, bodyHits = 0;
  const base = await serve((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/target" }).end();
      return;
    }
    if (req.url === "/target" && targetHits++ === 0) {
      req.socket.destroy();
      return;
    }
    if (req.url === "/body" && bodyHits++ === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"partial":');
      setTimeout(() => res.destroy(), 5);
      return;
    }
    res.end('{"ok":true}');
  });
  expect(await loadJson(`${base}/redirect`)).toEqual({ ok: true });
  expect(targetHits).toBe(2);
  expect(await loadJson(`${base}/body`)).toEqual({ ok: true });
  expect(bodyHits).toBe(2);
});
it("honors Retry-After seconds/dates or explicitly rejects a wait beyond its budget", async () => {
  let hits = 0;
  const base = await serve((_req, res) => {
    hits++;
    res.writeHead(429, { "Retry-After": "60" }).end();
  });
  await expect(loadJson(base)).rejects.toThrow("Retry-After exceeds");
  expect(hits).toBe(1);
});
