// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";
import http from "node:http";
import { MongoClient } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { RequestScheduler, WorkerTypeConfig } from "./request-scheduler.js";
import { PostProcessorDispatcher } from "./post-processor-dispatcher.js";
import type { RequestDocument } from "@scope/core";

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
const HEALTH_PORT = parseInt(process.env.PORT || "8080", 10);

/**
 * Parse per-worker-type queue depth config from environment.
 * Format: SCHEDULER_QUEUE_DEPTH_<WORKER_TYPE_SCREAMING_SNAKE>=<number>
 *
 * Also reads SCHEDULER_WORKER_TYPES (comma-separated) to know which
 * worker types to schedule for.
 */
function buildWorkerTypeConfigs(): WorkerTypeConfig[] {
  const workerTypes = (
    process.env.SCHEDULER_WORKER_TYPES || "coder-acp-copilot,coder-acp-claude-code"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const configs: WorkerTypeConfig[] = [];

  for (const workerType of workerTypes) {
    // Convert worker-type to SCREAMING_SNAKE for env var lookup
    const envKey = `SCHEDULER_QUEUE_DEPTH_${workerType.replace(/-/g, "_").toUpperCase()}`;
    const targetQueueDepth = parseInt(process.env[envKey] || "5", 10);

    // Queue name follows existing convention: queue-<workerType>
    const queueName =
      process.env[`QUEUE_NAME_${workerType.replace(/-/g, "_").toUpperCase()}`] ||
      `queue-${workerType}`;

    const queueClient = createQueueClient(queueName);

    configs.push({ workerType, queueClient, targetQueueDepth });
    console.log(
      `[Scheduler] Worker type: ${workerType}, queue: ${queueName}, targetDepth: ${targetQueueDepth}`,
    );
  }

  return configs;
}

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
  console.log("[Scheduler] Starting...");
  console.log(`[Scheduler] MongoDB: ${MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);
  console.log(`[Scheduler] Poll interval: ${POLL_INTERVAL_MS}ms`);

  // Connect to MongoDB
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  console.log("[Scheduler] Connected to MongoDB");

  const db = mongoClient.db(MONGO_DATABASE);
  const collection = db.collection<RequestDocument>(MONGO_COLLECTION);

  // Build worker type configs from environment
  const workerTypeConfigs = buildWorkerTypeConfigs();

  if (workerTypeConfigs.length === 0) {
    console.error("[Scheduler] No worker types configured. Set SCHEDULER_WORKER_TYPES.");
    process.exit(1);
  }

  // Ensure all queues exist (creates them in Azurite on first run)
  for (const wt of workerTypeConfigs) {
    await wt.queueClient.createIfNotExists();
    console.log(`[Scheduler] Ensured queue exists for ${wt.workerType}`);
  }

  // Start the scheduler
  const scheduler = new RequestScheduler(
    collection,
    workerTypeConfigs,
    POLL_INTERVAL_MS,
  );
  scheduler.start();
  console.log("[Scheduler] Dispatch loop started");

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
    healthServer.close();
    await mongoClient.close();
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
