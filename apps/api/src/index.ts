// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express, { type Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { MongoClient, Db, Collection } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { createQueueClientFactory } from "./utils/queue-client-factory.js";
import dotenv from "dotenv";
import { SkillRevisionStore, SkillResolver, McpSecretClient, McpSecretUnavailableError } from "@scope/agent-protocol";
import { TaskPromptStore, BlobStorage } from "@scope/platform";
import { RedisHeartbeatStore } from "@scope/worker-runtime";
import type { SkillDocument, SkillRevisionDocument, TaskPromptDocument, ProfileDocument, ProfileVersionDocument } from "@scope/core";
import type { HeartbeatStore } from "@scope/worker-runtime";
import { acquireGitHubPublicApiToken } from "./github-api-token.js";
import { generateOpenAPIDocument, registry } from "./openapi/index.js";
import swaggerUi from "swagger-ui-express";
import { registerFeatureFlagRoutes } from "./routes/feature-flags.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerRequestsRoutes } from "./routes/requests/index.js";
import { registerRequestsCancelRoutes } from "./routes/requests/cancel.js";
import { registerRequestsLogsRoutes } from "./routes/requests/logs.js";
import { registerRequestsHarRoutes } from "./routes/requests/har.js";
import { registerRequestsAtifRoutes } from "./routes/requests/atif.js";
import { registerRequestsVideoRoutes } from "./routes/requests/video.js";
import { registerRequestsToolCallsRoutes } from "./routes/requests/tool-calls.js";
import { registerRequestsSnapshotsRoutes } from "./routes/requests/snapshots.js";
import { registerRequestsArchiveRoutes } from "./routes/requests/archive.js";
import { registerCriteriaRoutes } from "./routes/criteria.js";
import { registerPromptFeaturesRoutes } from "./routes/prompt-features.js";
import { registerTaskPromptsRoutes } from "./routes/task-prompts.js";
import { registerReportsRoutes } from "./routes/reports.js";
import { registerReportTemplatesRoutes } from "./routes/report-templates.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerMcpServersRoutes } from "./routes/mcp-servers.js";
import { registerSkillsRoutes } from "./routes/skills.js";
import { registerExtensionsRoutes } from "./routes/extensions.js";
import { registerInsightsRoutes } from "./routes/insights.js";
import { registerSecretsRoutes } from "./routes/secrets.js";
import { registerProfilesRoutes } from "./routes/profiles.js";
import { VALID_WORKERS } from "./route-context.js";
import type { RouteContext } from "./route-context.js";
import type {
  CriteriaDocument,
  PromptFeatureDocument,
  PromptFeatureExtractionDocument,
  ReportDocument,
  ReportTemplateDocument,
  InsightDocument,
  RequestDocument,
  RunHistoryDocument,
  CodingAgentDocument,
  ModelDocument,
  McpServerDocument,
  ExtensionDocument,
  FeatureFlagDocument,
  WorkerType,
} from "./route-context.js";

dotenv.config();

const TOKEN_MANAGER_URL = process.env.TOKEN_MANAGER_URL || "";
const mcpSecretClient: McpSecretClient | null = TOKEN_MANAGER_URL
  ? new McpSecretClient(TOKEN_MANAGER_URL)
  : null;

const app: Express = express();
app.use(cors());
app.use(express.json());

// Configuration from environment
// K8s: MONGO_CONNECTION_STRING from secret, STORAGE_CONNECTION_STRING from secret
const mongoUri = process.env.MONGO_CONNECTION_STRING || process.env.MONGO_URI || "mongodb://localhost:27000";
const mongoDatabase = process.env.MONGO_DATABASE || "requests-db";
const mongoCollection = process.env.MONGO_COLLECTION || "requests";
const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
const storageConnectionString = process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING || "";
const queueWorker1 = process.env.AZURE_STORAGE_QUEUE_WORKER_1 || "queue-coder-acp-claude-code";
const queueWorker2 = process.env.AZURE_STORAGE_QUEUE_WORKER_2 || "queue-coder-acp-copilot";
const queueReport = process.env.AZURE_STORAGE_QUEUE_REPORT || "report-queue";
const port = parseInt(process.env.PORT || "3000", 10);

// MongoDB clients
let mongoClient: MongoClient;
let db: Db;
let collection: Collection<RequestDocument>;
let runsCol: Collection<RunHistoryDocument>;
let criteriaCollection: Collection<CriteriaDocument>;
let promptFeatureCollection: Collection<PromptFeatureDocument>;
let promptFeatureExtractionCollection: Collection<PromptFeatureExtractionDocument>;
let reportCollection: Collection<ReportDocument>;
let agentCollection: Collection<CodingAgentDocument>;
let modelCollection: Collection<ModelDocument>;
let mcpServerCollection: Collection<McpServerDocument>;
let insightsCollection: Collection<InsightDocument>;
let taskPromptCollection: Collection<TaskPromptDocument>;
let taskPromptStore: TaskPromptStore;
let featureFlagCollection: Collection<FeatureFlagDocument>;
let reportTemplateCollection: Collection<ReportTemplateDocument>;
let skillCollection: Collection<SkillDocument>;
let extensionCollection: Collection<ExtensionDocument>;
let skillRevisionCollection: Collection<SkillRevisionDocument>;
let skillRevisionStore: SkillRevisionStore;
let profileCollection: Collection<ProfileDocument>;
let profileVersionCollection: Collection<ProfileVersionDocument>;
let skillResolver: SkillResolver;
let blobStorage: BlobStorage;
let heartbeatStore: HeartbeatStore;
const queueClients: Map<WorkerType, QueueClient> = new Map();
let reportQueueClient: QueueClient;

async function initializeClients(): Promise<void> {
  // Connect to MongoDB
  mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  db = mongoClient.db(mongoDatabase);
  collection = db.collection<RequestDocument>(mongoCollection);
  runsCol = db.collection<RunHistoryDocument>("runs");
  criteriaCollection = db.collection<CriteriaDocument>("criteria");
  promptFeatureCollection = db.collection<PromptFeatureDocument>("prompt-features");
  promptFeatureExtractionCollection = db.collection<PromptFeatureExtractionDocument>("prompt-feature-extractions");
  reportCollection = db.collection<ReportDocument>("reports");
  agentCollection = db.collection<CodingAgentDocument>("agents");
  modelCollection = db.collection<ModelDocument>("models");
  mcpServerCollection = db.collection<McpServerDocument>("mcp-servers");
  insightsCollection = db.collection<InsightDocument>("insights");
  taskPromptCollection = db.collection<TaskPromptDocument>("task-prompts");
  taskPromptStore = new TaskPromptStore(taskPromptCollection);
  featureFlagCollection = db.collection<FeatureFlagDocument>("feature-flags");
  reportTemplateCollection = db.collection<ReportTemplateDocument>("report-templates");
  skillCollection = db.collection<SkillDocument>("skills");
  extensionCollection = db.collection<ExtensionDocument>("extensions");
  skillRevisionCollection = db.collection<SkillRevisionDocument>("skill-revisions");
  skillRevisionStore = new SkillRevisionStore(skillRevisionCollection);
  skillResolver = new SkillResolver({
    tokenProvider: acquireGitHubPublicApiToken,
  });
  profileCollection = db.collection<ProfileDocument>("profiles");
  profileVersionCollection = db.collection<ProfileVersionDocument>("profile-versions");

  // Note: Collection indexes are managed by db-migrations (see 002-create-indexes.ts).
  // Run `pnpm migrate:up` to apply pending migrations.

  // Seed default feature flags (upsert — won't overwrite existing enabled state)
  const defaultFlags: Array<{ key: string; label: string }> = [
    { key: "mcp", label: "MCP Servers" },
    { key: "models", label: "Models" },
    { key: "agents", label: "Agents" },
    { key: "tokens", label: "Tokens" },
    { key: "extensions", label: "VS Code Extensions" },
    { key: "statistics-graph", label: "Statistics Graph" },
  ];
  for (const flag of defaultFlags) {
    await featureFlagCollection.updateOne(
      { key: flag.key },
      { $setOnInsert: { key: flag.key, label: flag.label, enabled: true, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  // Seed default agents (upsert — always updates name and modelProvider, preserves existing models)
  const defaultAgents: Array<{ _id: string; name: string; modelProvider?: string }> = [
    { _id: "coder-acp-claude-code", name: "Claude Code CLI", modelProvider: "anthropic" },
    { _id: "coder-acp-copilot", name: "GitHub Copilot CLI", modelProvider: "github-copilot" },
  ];
  for (const agent of defaultAgents) {
    await agentCollection.updateOne(
      { _id: agent._id },
      {
        $set: { name: agent.name, ...(agent.modelProvider ? { modelProvider: agent.modelProvider } : {}) },
        $setOnInsert: { supportedModels: [], createdAt: new Date() },
      },
      { upsert: true }
    );
  }
  console.log(`Ensured ${defaultAgents.length} default agents exist`);
  
  console.log(`Connected to MongoDB: ${mongoUri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);

  // Initialize queue clients
  if (storageConnectionString) {
    // Connection string auth (local Azurite or Azure with connection string)
    queueClients.set("coder-acp-claude-code", new QueueClient(storageConnectionString, queueWorker1));
    queueClients.set("coder-acp-copilot", new QueueClient(storageConnectionString, queueWorker2));
    reportQueueClient = new QueueClient(storageConnectionString, queueReport);
  } else {
    // Azure with DefaultAzureCredential
    const credential = new DefaultAzureCredential();
    const queueUrl = `https://${storageAccountName}.queue.core.windows.net`;
    queueClients.set("coder-acp-claude-code", new QueueClient(`${queueUrl}/${queueWorker1}`, credential));
    queueClients.set("coder-acp-copilot", new QueueClient(`${queueUrl}/${queueWorker2}`, credential));
    reportQueueClient = new QueueClient(`${queueUrl}/${queueReport}`, credential);
  }

  // Ensure queues exist (creates them in Azurite on first run)
  for (const [name, client] of queueClients) {
    await client.createIfNotExists();
    console.log(`Ensured queue exists: ${name}`);
  }
  await reportQueueClient.createIfNotExists();
  console.log(`Ensured queue exists: ${queueReport}`);

  console.log(`Initialized Queue clients for workers: ${Array.from(queueClients.keys()).join(", ")}, report`);

  // Initialize blob storage (used for log persistence and snapshots)
  blobStorage = new BlobStorage({ storageAccountName, storageConnectionString });

  // Initialize Redis-backed heartbeat store. Workers write per-run
  // heartbeats here; the API enriches `processing` runs with the latest
  // value so the portal can render "Last heartbeat: Xs ago". Failures are
  // non-fatal: a missing heartbeat just means no enrichment for that run.
  heartbeatStore = new RedisHeartbeatStore({
    redisHost: process.env.REDIS_HOST || "",
    redisPort: parseInt(process.env.REDIS_PORT || "6300", 10),
    redisPassword: process.env.REDIS_PASSWORD || "",
  });
}

// --- OpenAPI documentation (lazy — Swagger UI mounted in main() after all routes register) ---

// Shared route context — module-level vars are populated by initializeClients()
// before any HTTP request arrives, so handlers see the initialized values.
const routeCtx: RouteContext = {
  get app() { return app; },
  get registry() { return registry; },
  get db() { return db; },
  get requestCollection() { return collection; },
  get runsCollection() { return runsCol; },
  get criteriaCollection() { return criteriaCollection; },
  get promptFeatureCollection() { return promptFeatureCollection; },
  get promptFeatureExtractionCollection() { return promptFeatureExtractionCollection; },
  get reportCollection() { return reportCollection; },
  get reportTemplateCollection() { return reportTemplateCollection; },
  get agentCollection() { return agentCollection; },
  get modelCollection() { return modelCollection; },
  get mcpServerCollection() { return mcpServerCollection; },
  get mcpSecretClient() { return mcpSecretClient; },
  get insightsCollection() { return insightsCollection; },
  get profileCollection() { return profileCollection; },
  get profileVersionCollection() { return profileVersionCollection; },
  get taskPromptCollection() { return taskPromptCollection; },
  get featureFlagCollection() { return featureFlagCollection; },
  get skillCollection() { return skillCollection; },
  get extensionCollection() { return extensionCollection; },
  get skillRevisionCollection() { return skillRevisionCollection; },
  get taskPromptStore() { return taskPromptStore; },
  get skillRevisionStore() { return skillRevisionStore; },
  get skillResolver() { return skillResolver; },
  get queueClients() { return queueClients; },
  get reportQueueClient() { return reportQueueClient; },
  get blobStorage() { return blobStorage; },
  get heartbeatStore() { return heartbeatStore; },
  getOrCreateQueueClient: createQueueClientFactory(storageConnectionString, storageAccountName),
  validWorkers: VALID_WORKERS,
  storageConnectionString,
  storageAccountName,
};

// ─── Route registration ───────────────────────────────────────────────────────
// Secrets/proxy routes must be registered first (before :id param routes)
registerSecretsRoutes(routeCtx);
registerSystemRoutes(routeCtx);
registerRequestsRoutes(routeCtx);
registerRequestsCancelRoutes(routeCtx);
registerRequestsLogsRoutes(routeCtx);
registerRequestsHarRoutes(routeCtx);
registerRequestsAtifRoutes(routeCtx);
registerRequestsVideoRoutes(routeCtx);
registerRequestsToolCallsRoutes(routeCtx);
registerRequestsSnapshotsRoutes(routeCtx);
registerRequestsArchiveRoutes(routeCtx);
registerCriteriaRoutes(routeCtx);
registerPromptFeaturesRoutes(routeCtx);
registerTaskPromptsRoutes(routeCtx);
registerReportsRoutes(routeCtx);
registerProfilesRoutes(routeCtx);
registerReportTemplatesRoutes(routeCtx);
registerAgentsRoutes(routeCtx);
registerModelsRoutes(routeCtx);
registerMcpServersRoutes(routeCtx);
registerSkillsRoutes(routeCtx);
registerExtensionsRoutes(routeCtx);
registerInsightsRoutes(routeCtx);
registerFeatureFlagRoutes(routeCtx);

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof McpSecretUnavailableError) {
    res.status(503).json({ error: err.message });
    return;
  }
  console.error("Error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

async function main(): Promise<void> {
  await initializeClients();

  // Mount OpenAPI docs (after all routes are registered)
  const openapiDocument = generateOpenAPIDocument();
  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(openapiDocument);
  });
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

  app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });
}

// ─── Test support ────────────────────────────────────────────────────────────
// Allows tests to inject mock dependencies without starting the server.

export { app };

export interface TestDependencies {
  db?: Db;
  collection?: Collection<RequestDocument>;
  runsCollection?: Collection<RunHistoryDocument>;
  criteriaCollection?: Collection<CriteriaDocument>;
  promptFeatureCollection?: Collection<PromptFeatureDocument>;
  promptFeatureExtractionCollection?: Collection<PromptFeatureExtractionDocument>;
  reportCollection?: Collection<ReportDocument>;
  agentCollection?: Collection<CodingAgentDocument>;
  modelCollection?: Collection<ModelDocument>;
  mcpServerCollection?: Collection<McpServerDocument>;
  insightsCollection?: Collection<InsightDocument>;
  profileCollection?: Collection<ProfileDocument>;
  profileVersionCollection?: Collection<ProfileVersionDocument>;
  taskPromptCollection?: Collection<TaskPromptDocument>;
  taskPromptStore?: TaskPromptStore;
  featureFlagCollection?: Collection<FeatureFlagDocument>;
  reportTemplateCollection?: Collection<ReportTemplateDocument>;
  skillCollection?: Collection<SkillDocument>;
  skillRevisionCollection?: Collection<SkillRevisionDocument>;
  skillRevisionStore?: SkillRevisionStore;
  skillResolver?: SkillResolver;
  queueClients?: Map<WorkerType, QueueClient>;
  reportQueueClient?: QueueClient;
  blobStorage?: BlobStorage;
}

/** @internal — used by tests only to inject mock dependencies */
export function _injectTestDependencies(deps: TestDependencies): void {
  if (deps.db) db = deps.db;
  if (deps.collection) collection = deps.collection;
  if (deps.runsCollection) runsCol = deps.runsCollection;
  if (deps.criteriaCollection) criteriaCollection = deps.criteriaCollection;
  if (deps.promptFeatureCollection) promptFeatureCollection = deps.promptFeatureCollection;
  if (deps.promptFeatureExtractionCollection) promptFeatureExtractionCollection = deps.promptFeatureExtractionCollection;
  if (deps.reportCollection) reportCollection = deps.reportCollection;
  if (deps.agentCollection) agentCollection = deps.agentCollection;
  if (deps.modelCollection) modelCollection = deps.modelCollection;
  if (deps.mcpServerCollection) mcpServerCollection = deps.mcpServerCollection;
  if (deps.insightsCollection) insightsCollection = deps.insightsCollection;
  if (deps.profileCollection) profileCollection = deps.profileCollection;
  if (deps.profileVersionCollection) profileVersionCollection = deps.profileVersionCollection;
  if (deps.taskPromptCollection) taskPromptCollection = deps.taskPromptCollection;
  if (deps.taskPromptStore) taskPromptStore = deps.taskPromptStore;
  if (deps.featureFlagCollection) featureFlagCollection = deps.featureFlagCollection;
  if (deps.reportTemplateCollection) reportTemplateCollection = deps.reportTemplateCollection;
  if (deps.skillCollection) skillCollection = deps.skillCollection;
  if (deps.skillRevisionCollection) skillRevisionCollection = deps.skillRevisionCollection;
  if (deps.skillRevisionStore) skillRevisionStore = deps.skillRevisionStore;
  if (deps.skillResolver) skillResolver = deps.skillResolver;
  if (deps.queueClients) queueClients.clear(), deps.queueClients.forEach((v, k) => queueClients.set(k, v));
  if (deps.reportQueueClient) reportQueueClient = deps.reportQueueClient;
  if (deps.blobStorage) blobStorage = deps.blobStorage;
}

// ─── Start server (skipped in test environment) ──────────────────────────────

if (!process.env.VITEST) {
  main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
