// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";
import { initTelemetry } from "telemetry";

initTelemetry("scope-report-generator");

import { ReportQueueProcessor, ReportQueueProcessorConfig } from "./report-queue-processor.js";
import { resolveReportModel } from "./report-config.js";

const config: ReportQueueProcessorConfig = {
  mongoUri: process.env.MONGO_CONNECTION_STRING || process.env.AZURE_COSMOS_CONNECTION_STRING || "mongodb://localhost:27017",
  mongoDatabase: process.env.MONGO_DATABASE || "requests-db",
  mongoCollection: "reports",
  storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || "devstoreaccount1",
  storageConnectionString: process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING || undefined,
  queueName: process.env.AZURE_STORAGE_QUEUE_REPORT || "report-queue",
  batchSize: Number(process.env.BATCH_SIZE) || 1,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 5000,
  redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: Number(process.env.REDIS_PORT) || 6379,
  redisPassword: process.env.REDIS_PASSWORD || "",
  reportModel: resolveReportModel(),
  apiBaseUrl: process.env.SCOPE_MT_API_URL || "http://localhost:3001",
  sessionTimeoutMs: Number(process.env.SESSION_TIMEOUT_MS) || 5 * 60 * 1000,
};

const processor = new ReportQueueProcessor(config);
processor.start().catch((err) => {
  console.error("[report-generator] Fatal error:", err);
  process.exit(1);
});
