// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";
import http from "node:http";
import { MongoClient } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { RequestScheduler } from "./request-scheduler.js";
import { PostProcessorDispatcher } from "./post-processor-dispatcher.js";
import { StuckRunReaper } from "./stuck-run-reaper.js";
import { RedisHeartbeatStore, type HeartbeatStore } from "shared";
import type { CodingAgentDocument, RequestDocument } from "shared";
import { initTelemetry, trackMetric, trackEvent, shutdownTelemetry } from "telemetry";

// ── Configuration ────────────────────────────────────────────────────

const MONGO_URI =
  process.env.MONGO_CONNECTION_STRING ||
  process.env.MONGO_URI ||
  "mongodb://localhost:27017";
const MONGO_DATABASE = process.env.MONGO_DATABASE || "requests-db";
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "requests";

const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
const STORAGE_CONNECTION_STRING =
  process.env.STORAGE_CONNECTION_STRING ||
  process.env.AZURE_STORAGE_CONNECTION_STRING;

const POLL_INTERVAL_MS = parseInt(
  process.env.SCHEDULER_POLL_INTERVAL_MS || "2000",
  10,
);
const TARGET_QUEUE_DEPTH = parsePositiveInt(
  process.env.SCHEDULER_TARGET_QUEUE_DEPTH,
  5,
  1,
  "SCHEDULER_TARGET_QUEUE_DEPTH",
);
const QUEUE_RECONCILIATION_INTERVAL_MS = parsePositiveInt(
  process.env.SCHEDULER_QUEUE_RECONCILIATION_INTERVAL_MS,
  30_000,
  1_000,
  "SCHEDULER_QUEUE_RECONCILIATION_INTERVAL_MS",
);
const HEALTH_PORT = parseInt(process.env.PORT || "8080", 10);

/**
 * Parse a positive-integer env var with validation. Returns `fallback` (with a
 * loud warning) when the value is missing, non-numeric, non-integer, or below
 * `min`. Used for reaper safety controls where a `NaN` could otherwise disable
 * the circuit-breaker or create a tight sweep loop.
 */
function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  label: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    console.warn(
      `[Scheduler] Invalid ${label}=${JSON.stringify(raw)} (need integer >= ${min}); using ${fallback}`,
    );
    return fallback;
  }
  return n;
}

// ── Stuck-run reaper config ──────────────────────────────────────────
// The reaper is the authoritative backstop that fails runs stuck in
// `processing` whose worker died without writing a terminal state. It needs
// Redis to read per-run liveness heartbeats. Redis is treated as NON-FATAL:
// if it is not configured or unreachable, the reaper self-disables while the
// dispatch loop keeps running.
//
// Disabled by default: set SCOPE_REAPER_ENABLED=true to turn it on.

const REAPER_ENABLED = process.env.SCOPE_REAPER_ENABLED === "true";
const REAPER_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.SCOPE_REAPER_POLL_INTERVAL_MS,
  60000,
  1000,
  "SCOPE_REAPER_POLL_INTERVAL_MS",
);
const REAPER_MAX_PER_SWEEP = parsePositiveInt(
  process.env.SCOPE_REAPER_MAX_PER_SWEEP,
  30,
  1,
  "SCOPE_REAPER_MAX_PER_SWEEP",
);
// Staleness threshold — kept in sync with the redelivery handler so both
// recovery paths agree on when a worker is "dead".
const RUN_HEARTBEAT_STALE_MS = parsePositiveInt(
  process.env.SCOPE_RUN_HEARTBEAT_STALE_MS,
  120000,
  1000,
  "SCOPE_RUN_HEARTBEAT_STALE_MS",
);

function createQueueClient(queueName: string): QueueClient {
  if (STORAGE_CONNECTION_STRING) {
    return new QueueClient(STORAGE_CONNECTION_STRING, queueName);
  }
  const credential = new DefaultAzureCredential();
  const queueUrl = `https://${STORAGE_ACCOUNT}.queue.core.windows.net/${queueName}`;
  return new QueueClient(queueUrl, credential);
}

// ── Health Check Server ──────────────────────────────────────────────

function createHealthServer(): http.Server {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "scheduler" }));
  });
  return server;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  initTelemetry("scope-scheduler");
  const coldStartMs = process.uptime() * 1000;

  console.log("[Scheduler] Starting...");
  console.log(`[Scheduler] MongoDB: ${MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);
  console.log(`[Scheduler] Poll interval: ${POLL_INTERVAL_MS}ms`);

  // Connect to MongoDB
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  console.log("[Scheduler] Connected to MongoDB");

  const db = mongoClient.db(MONGO_DATABASE);
  const collection = db.collection<RequestDocument>(MONGO_COLLECTION);
  const agentCollection = db.collection<CodingAgentDocument>("agents");

  // Start the scheduler
  const scheduler = new RequestScheduler(
    collection,
    agentCollection,
    createQueueClient,
    {
      pollIntervalMs: POLL_INTERVAL_MS,
      targetQueueDepth: TARGET_QUEUE_DEPTH,
      queueReconciliationIntervalMs: QUEUE_RECONCILIATION_INTERVAL_MS,
    },
  );
  scheduler.start();
  console.log("[Scheduler] Dispatch loop started");
  trackMetric({ name: "scheduler.cold_start_ms", value: coldStartMs, properties: { service: "scheduler" } });
  trackEvent({
    name: "scheduler.dispatch_started",
    properties: { discovery: "agent-registry" },
  });

  // Start the post-processor dispatcher
  const postProcessorQueueName = process.env.QUEUE_NAME_POST_PROCESSOR || "post-processor-queue";
  const postProcessorQueueClient = createQueueClient(postProcessorQueueName);
  await postProcessorQueueClient.createIfNotExists();
  console.log(`[Scheduler] Ensured post-processor queue exists: ${postProcessorQueueName}`);

  const ppPollIntervalMs = parseInt(
    process.env.SCHEDULER_PP_POLL_INTERVAL_MS || "30000",
    10,
  );

  const postProcessorDispatcher = new PostProcessorDispatcher(
    collection,
    db,
    postProcessorQueueClient,
    ppPollIntervalMs,
  );
  postProcessorDispatcher.start();
  console.log("[Scheduler] Post-processor dispatch loop started");

  // Start the stuck-run reaper (authoritative backstop). Redis is non-fatal:
  // on misconfig or connection failure the reaper self-disables (its sweeps
  // skip when ping() fails) while the dispatch loop above keeps running.
  let heartbeatStore: HeartbeatStore | null = null;
  let stuckRunReaper: StuckRunReaper | null = null;
  if (REAPER_ENABLED && process.env.REDIS_HOST) {
    try {
      heartbeatStore = new RedisHeartbeatStore({
        redisHost: process.env.REDIS_HOST || "",
        redisPort: parseInt(process.env.REDIS_PORT || "6300", 10),
        redisPassword: process.env.REDIS_PASSWORD || "",
      });
      stuckRunReaper = new StuckRunReaper(collection, heartbeatStore, {
        pollIntervalMs: REAPER_POLL_INTERVAL_MS,
        staleThresholdMs: RUN_HEARTBEAT_STALE_MS,
        maxPerSweep: REAPER_MAX_PER_SWEEP,
      });
      stuckRunReaper.start();
      console.log(
        `[Scheduler] Stuck-run reaper started (poll=${REAPER_POLL_INTERVAL_MS}ms, stale=${RUN_HEARTBEAT_STALE_MS}ms, maxPerSweep=${REAPER_MAX_PER_SWEEP})`,
      );
    } catch (err) {
      // Never let reaper setup take down the scheduler — dispatch is critical.
      console.error(
        "[Scheduler] Failed to start stuck-run reaper (continuing without it):",
        err,
      );
      stuckRunReaper = null;
      heartbeatStore = null;
    }
  } else {
    console.warn(
      `[Scheduler] Stuck-run reaper disabled (${REAPER_ENABLED ? "REDIS_HOST not set" : "SCOPE_REAPER_ENABLED not set to true"})`,
    );
  }

  // Start health check server
  const healthServer = createHealthServer();
  healthServer.listen(HEALTH_PORT, () => {
    console.log(`[Scheduler] Health check listening on :${HEALTH_PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Scheduler] Shutting down...");
    await scheduler.stop();
    await postProcessorDispatcher.stop();
    if (stuckRunReaper) await stuckRunReaper.stop();
    if (heartbeatStore) await heartbeatStore.close();
    healthServer.close();
    await mongoClient.close();
    await shutdownTelemetry();
    console.log("[Scheduler] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[Scheduler] Fatal error:", err);
  process.exit(1);
});
