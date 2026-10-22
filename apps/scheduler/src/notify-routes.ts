// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import http from "node:http";
import type { HandlerServiceDocument } from "shared";

/**
 * Maximum accepted request body size for the scheduler's HTTP endpoints.
 * Notify/register payloads are a few hundred bytes; 64 KB is a generous cap
 * that protects this singleton control-plane process from unbounded buffering
 * (and OOM) if a buggy caller streams a large body.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** Thrown by readJsonBody when the request body exceeds MAX_BODY_BYTES. */
class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes}-byte limit`);
    this.name = "PayloadTooLargeError";
  }
}

export interface NotifyHandler {
  onRunTerminal(requestId: string, runId: string): Promise<void>;
  onHandlerComplete(
    requestId: string,
    runId: string,
    handlerId: string,
    status: "done" | "failed",
  ): Promise<void>;
  registerHandler(doc: HandlerServiceDocument): Promise<void>;
}

interface RunTerminalRequest {
  requestId: string;
  runId: string;
}

interface HandlerCompleteRequest {
  requestId: string;
  runId: string;
  handlerId: string;
  status: "done" | "failed";
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: object,
  extraHeaders?: http.OutgoingHttpHeaders,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRunTerminalRequest(body: unknown): RunTerminalRequest | null {
  if (!isRecord(body)) {
    return null;
  }

  if (!isNonEmptyString(body.requestId) || !isNonEmptyString(body.runId)) {
    return null;
  }

  return {
    requestId: body.requestId,
    runId: body.runId,
  };
}

function parseHandlerCompleteRequest(body: unknown): HandlerCompleteRequest | null {
  if (!isRecord(body)) {
    return null;
  }

  if (
    !isNonEmptyString(body.requestId) ||
    !isNonEmptyString(body.runId) ||
    !isNonEmptyString(body.handlerId) ||
    (body.status !== "done" && body.status !== "failed")
  ) {
    return null;
  }

  return {
    requestId: body.requestId,
    runId: body.runId,
    handlerId: body.handlerId,
    status: body.status,
  };
}

function parseHandlerRegisterRequest(body: unknown): HandlerServiceDocument | null {
  if (!isRecord(body)) {
    return null;
  }

  const {
    _id,
    type,
    version,
    queue,
    selector,
    autoBackfill,
    dependsOn,
  } = body;

  if (
    !isNonEmptyString(_id) ||
    type !== "post-process-handler" ||
    typeof version !== "number" ||
    !Number.isFinite(version) ||
    !isNonEmptyString(queue) ||
    !isNonEmptyString(selector) ||
    typeof autoBackfill !== "boolean" ||
    !Array.isArray(dependsOn) ||
    !dependsOn.every((d) => isNonEmptyString(d))
  ) {
    return null;
  }

  return {
    _id,
    type,
    version,
    queue,
    selector,
    autoBackfill,
    dependsOn: dependsOn as string[],
  };
}

export function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Fast path: reject an oversized declared Content-Length before reading any
    // body. Well-behaved clients (fetch/axios/http.request with a body) always
    // send it, so this catches the common case without buffering a single byte.
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      reject(new PayloadTooLargeError(maxBytes));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    // Streaming guard: Content-Length may be absent (chunked) or lie, so also
    // enforce the cap as bytes arrive and bail the moment it is exceeded.
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const rawBody = Buffer.concat(chunks).toString("utf-8").trim();
      if (rawBody.length === 0) {
        reject(new Error("Request body is required"));
        return;
      }
      try {
        resolve(JSON.parse(rawBody) as unknown);
      } catch (err) {
        reject(err);
      }
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export interface HttpServerOptions {
  /** Max request body size in bytes. Defaults to MAX_BODY_BYTES (64 KB). */
  maxBodyBytes?: number;
}

export function createHttpServer(
  handler: NotifyHandler,
  options: HttpServerOptions = {},
): http.Server {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok", service: "scheduler" });
        return;
      }

      if (method === "POST" && url.pathname === "/notify/run-terminal") {
        const parsedBody = parseRunTerminalRequest(await readJsonBody(req, maxBodyBytes));
        if (!parsedBody) {
          sendJson(res, 400, { error: "requestId and runId are required" });
          return;
        }

        await handler.onRunTerminal(parsedBody.requestId, parsedBody.runId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/notify/handler-complete") {
        const parsedBody = parseHandlerCompleteRequest(await readJsonBody(req, maxBodyBytes));
        if (!parsedBody) {
          sendJson(res, 400, {
            error: "requestId, runId, handlerId, and status (done|failed) are required",
          });
          return;
        }

        await handler.onHandlerComplete(
          parsedBody.requestId,
          parsedBody.runId,
          parsedBody.handlerId,
          parsedBody.status,
        );
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/handlers/register") {
        const parsedBody = parseHandlerRegisterRequest(await readJsonBody(req, maxBodyBytes));
        if (!parsedBody) {
          sendJson(res, 400, {
            error:
              "Invalid handler registration: _id, type='post-process-handler', version (number), queue, selector, autoBackfill (boolean), and dependsOn (string[]) are required",
          });
          return;
        }

        await handler.registerHandler(parsedBody);
        sendJson(res, 200, { ok: true, handlerId: parsedBody._id });
        return;
      }
    } catch (error) {
      // Body was not fully consumed — close the connection so leftover bytes
      // can't corrupt the next request on a keep-alive socket.
      if (error instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: "Request body too large" }, { Connection: "close" });
        return;
      }

      const message = error instanceof Error ? error.message : "Internal server error";
      const statusCode =
        message === "Request body is required" || error instanceof SyntaxError ? 400 : 500;

      sendJson(res, statusCode, {
        error:
          statusCode === 400
            ? "Invalid JSON request body"
            : "Internal server error",
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });
}
