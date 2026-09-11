// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { AgentManager, parseAgentUpdate, SetupError } from "./agents.js";
import { isTargetId } from "./manifest.js";

export interface ServerStatus {
  status: "starting" | "ready" | "stopping";
  apiUrl?: string;
  portalUrl?: string;
  dataDir: string;
}

function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 8192) throw new SetupError("Request too large", 413);
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new SetupError("Invalid JSON"); }
}

export async function startControl(
  agents: AgentManager,
  status: () => ServerStatus,
  stop: () => void,
  listenHost = "127.0.0.1",
): Promise<{ port: number; listenHost: string; close: () => Promise<void> }> {
  if (isIP(listenHost) !== 4 || listenHost === "0.0.0.0") {
    throw new Error("Control requires loopback or an explicit local IPv4 bridge address");
  }
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url;
      if (request.method === "GET" && path === "/health") {
        respond(response, 200, status());
      } else if (request.method === "GET" && path === "/status") {
        respond(response, 200, agents.controlStatus());
      } else if (request.method === "PUT" && path?.startsWith("/agents/")) {
        const id = path.slice("/agents/".length);
        if (!isTargetId(id)) throw new SetupError("Unknown agent target", 404);
        await agents.configure(id, parseAgentUpdate(await body(request)));
        respond(response, 202, agents.controlStatus());
      } else if (request.method === "POST" && path === "/stop") {
        respond(response, 202, { status: "stopping" });
        setImmediate(stop);
      } else {
        respond(response, 404, { error: "Not found" });
      }
    })().catch((error: unknown) => respond(response, error instanceof SetupError ? error.status : 500, {
      error: error instanceof Error ? error.message : String(error),
    }));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, listenHost, () => { server.off("error", reject); resolve(); });
  });
  return {
    port: (server.address() as AddressInfo).port,
    listenHost: (server.address() as AddressInfo).address,
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
