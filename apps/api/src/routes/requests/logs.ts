// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import type { RunState } from "@scope/core";
import type { Response } from "express";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";
import { subscribeClient, unsubscribeClient } from "../../utils/sse.js";
import type { SSEClient } from "../../utils/sse.js";
import { resolveRunForRequest } from "./resolve-run.js";

/**
 * Shared SSE log-streaming handler.
 * Works for both request-level (uses request.run) and per-run (uses resolved run) endpoints.
 */
async function handleLogs(
  ctx: RouteContext,
  res: Response,
  req: import("express").Request,
  targetRun: RunState,
  id: string,
  fromStart: boolean,
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Replay logs from blob storage
  if (fromStart) {
    try {
      const logsUrl = targetRun.logsUrl;
      const pastLogs = logsUrl
        ? await ctx.blobStorage.getLogEvents(logsUrl)
        : await ctx.blobStorage.getLogEvents(id, targetRun._id);
      for (const log of pastLogs) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      }
    } catch (err) {
      console.error(`Failed to replay logs for request ${id}:`, err);
      res.write(`event: error\ndata: ${JSON.stringify({ message: "Cannot connect to log storage" })}\n\n`);
      res.end();
      return;
    }
  }

  // If the run is done, close immediately
  if (targetRun.status === "done") {
    const currentTurns = targetRun.turns;
    if (currentTurns && currentTurns.length > 0) {
      res.write(`data: ${JSON.stringify({ type: "turns_summary", turns: currentTurns.length, passed: targetRun.outcome === "succeeded" })}\n\n`);
    }
    res.write(`event: done\ndata: ${JSON.stringify({ status: targetRun.status, outcome: targetRun.outcome })}\n\n`);
    res.end();
    return;
  }

  // For active runs, subscribe to live updates
  let cleaned = false;
  let changeStream: ReturnType<typeof ctx.requestCollection.watch> | null = null;
  let redisSubscribed = false;

  const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
  let inactivityTimer: ReturnType<typeof setTimeout>;

  const resetInactivityTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      res.write(`event: timeout\ndata: ${JSON.stringify({ message: "Inactivity timeout" })}\n\n`);
      client.cleanup();
    }, INACTIVITY_TIMEOUT_MS);
  };

  // SSE heartbeat every 30s to prevent proxy/LB disconnects
  const heartbeat = setInterval(() => {
    if (!cleaned) {
      res.write(`:\n\n`);
    }
  }, 30_000);

  const client: SSEClient = {
    res,
    onActivity: resetInactivityTimer,
    cleanup: () => {
      if (!cleaned) {
        cleaned = true;
        clearTimeout(inactivityTimer);
        clearInterval(heartbeat);
        if (changeStream) {
          changeStream.close().catch((err: unknown) => console.error("Error closing change stream:", err));
        }
        if (redisSubscribed) {
          unsubscribeClient(id, client);
        }
        res.end();
      }
    },
  };

  // Start the inactivity timer
  resetInactivityTimer();

  // Try Redis subscription if configured
  if (process.env.REDIS_HOST) {
    try {
      await subscribeClient(id, client);
      redisSubscribed = true;
    } catch (err) {
      console.error(`Redis subscription failed for ${id}, using Change Streams only:`, err);
    }
  }

  // Use MongoDB Change Streams as fallback (or primary if Redis unavailable)
  try {
    changeStream = ctx.requestCollection.watch(
      [{ $match: { "documentKey._id": id, operationType: "update" } }],
      { fullDocument: "updateLookup" },
    );

    changeStream.on("change", (change: any) => {
      if (change.operationType === "update" && change.fullDocument) {
        const doc = change.fullDocument;
        const docStatus = doc.run?.status;
        const docOutcome = doc.run?.outcome;
        if (docStatus === "done") {
          res.write(`event: done\ndata: ${JSON.stringify({ status: docStatus, outcome: docOutcome })}\n\n`);
          client.cleanup();
        }
      }
    });

    changeStream.on("error", (err: unknown) => {
      console.error(`Change stream error for ${id}:`, err);
    });
  } catch (err) {
    console.error(`Failed to create change stream for ${id}:`, err);
  }

  // Cleanup on client disconnect
  req.on("close", () => client.cleanup());
}

export function registerRequestsLogsRoutes(ctx: RouteContext): void {

// Request-level log streaming
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/logs",
  tags: ["Requests"],
  summary: "Stream request logs (SSE)",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Server-sent event stream of log entries",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id } = req.params;
    const fromStart = req.query.fromStart === "true";

    const resource = await ctx.requestCollection.findOne({ _id: id });
    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    await handleLogs(ctx, res, req, resource.run!, id, fromStart);
  },
});

// Per-run log streaming
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/runs/:runId/logs",
  tags: ["Requests"],
  summary: "Stream logs for a specific attempt (SSE)",
  params: z.object({ id: z.string(), runId: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Server-sent event stream of log entries",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id, runId } = req.params;
    const fromStart = req.query.fromStart === "true";

    const resolved = await resolveRunForRequest(ctx, id, runId);
    if ("error" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    await handleLogs(ctx, res, req, resolved.run, id, fromStart);
  },
});

}
