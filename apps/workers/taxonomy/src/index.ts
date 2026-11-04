// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";
import { TaxonomyQueueProcessor, type TaxonomyQueueProcessorConfig } from "./taxonomy-queue-processor.js";

const config: TaxonomyQueueProcessorConfig = {
  mongoUri: process.env.MONGO_CONNECTION_STRING || process.env.AZURE_COSMOS_CONNECTION_STRING || "mongodb://localhost:27017",
  mongoDatabase: process.env.MONGO_DATABASE || "requests-db",
  mongoCollection: "requests",
  storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || "devstoreaccount1",
  storageConnectionString: process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING || undefined,
  queueName: process.env.AZURE_STORAGE_QUEUE_TAXONOMY || "pp-taxonomy-queue",
  batchSize: Number(process.env.BATCH_SIZE) || 1,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 5000,
  redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: Number(process.env.REDIS_PORT) || 6379,
  redisPassword: process.env.REDIS_PASSWORD || "",
  taxonomyModel: process.env.TAXONOMY_MODEL || "gpt-5.4",
  apiBaseUrl: process.env.SCOPE_MT_API_URL || "http://localhost:3001",
  sessionTimeoutMs: Number(process.env.SESSION_TIMEOUT_MS) || 5 * 60 * 1000,
  schedulerUrl: process.env.SCHEDULER_URL,
  tokenManagerUrl: process.env.TOKEN_MANAGER_URL,
};

const processor = new TaxonomyQueueProcessor(config);
processor.start().catch((err) => {
  console.error("[taxonomy-handler] Fatal error:", err);
  process.exit(1);
});
