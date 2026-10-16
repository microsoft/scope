// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";
import {
  ReadoutQueueProcessor,
  type ReadoutQueueProcessorConfig,
} from "./readout-queue-processor.js";

const config: ReadoutQueueProcessorConfig = {
  mongoUri:
    process.env.MONGO_CONNECTION_STRING ||
    process.env.AZURE_COSMOS_CONNECTION_STRING ||
    "mongodb://localhost:27017",
  mongoDatabase: process.env.MONGO_DATABASE || "requests-db",
  mongoCollection: "submissions",
  storageAccountName:
    process.env.AZURE_STORAGE_ACCOUNT_NAME || "devstoreaccount1",
  storageConnectionString:
    process.env.STORAGE_CONNECTION_STRING ||
    process.env.AZURE_STORAGE_CONNECTION_STRING ||
    undefined,
  queueName: process.env.AZURE_STORAGE_QUEUE_READOUT || "pp-readout-queue",
  batchSize: Number(process.env.BATCH_SIZE) || 1,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 5000,
  redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: Number(process.env.REDIS_PORT) || 6379,
  redisPassword: process.env.REDIS_PASSWORD || "",
  model: process.env.READOUT_MODEL || "gpt-5.4",
  sessionTimeoutMs:
    Number(process.env.READOUT_SESSION_TIMEOUT_MS) || 5 * 60 * 1000,
  tokenManagerUrl: process.env.TOKEN_MANAGER_URL,
};

const processor = new ReadoutQueueProcessor(config);
processor.start().catch((error) => {
  console.error("[readout-handler] Fatal error:", error);
  process.exit(1);
});
