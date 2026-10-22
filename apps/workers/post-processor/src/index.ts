// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";
import { initTelemetry } from "telemetry";

initTelemetry("scope-post-processor");

import { PostProcessor, type PostProcessorConfig } from "./post-processor.js";
import { AtifHandler } from "./handlers/atif-handler.js";
import { TaxonomyHandler } from "./handlers/taxonomy-handler.js";

const config: PostProcessorConfig = {
  mongoUri: process.env.MONGO_CONNECTION_STRING || process.env.AZURE_COSMOS_CONNECTION_STRING || "mongodb://localhost:27017",
  mongoDatabase: process.env.MONGO_DATABASE || "requests-db",
  mongoCollection: "requests",
  storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || "devstoreaccount1",
  storageConnectionString: process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING || undefined,
  queueName: process.env.AZURE_STORAGE_QUEUE_POSTPROCESSOR || "post-processor-queue",
  batchSize: Number(process.env.BATCH_SIZE) || 1,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 5000,
  redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: Number(process.env.REDIS_PORT) || 6379,
  redisPassword: process.env.REDIS_PASSWORD || "",
  apiBaseUrl: process.env.SCOPE_MT_API_URL || process.env.API_BASE_URL || "http://localhost:3001",
};

const processor = new PostProcessor(config);

// Register handlers
processor.registerHandler(new AtifHandler());
processor.registerHandler(new TaxonomyHandler());

processor.start().catch((err) => {
  console.error("[post-processor] Fatal error:", err);
  process.exit(1);
});
