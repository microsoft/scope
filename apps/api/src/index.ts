// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express, { type Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { MongoClient, Db, Collection } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { TaskPromptStore, SkillRevisionStore, SkillResolver, CodebaseStore, CodebaseRevisionStore, CodebaseResolver, McpSecretClient, McpSecretUnavailableError, BlobStorage, RedisHeartbeatStore, ProjectStore, loadAuthConfigFromEnv } from "shared";
import { initTelemetry } from "telemetry";
import type { TaskPromptDocument, SkillDocument, SkillRevisionDocument, CodebaseDocument, CodebaseRevisionDocument, ProfileDocument, ProfileVersionDocument, ProjectDocument, HeartbeatStore, AuthProvider, ProfileEnricher, UserDocument } from "shared";
import { UserStore } from "./auth/user-store.js";
import { createAuthMiddleware, createUserAccessMiddleware } from "./auth/middleware.js";
import { authErrorHandler } from "./auth/error-handler.js";
import { RedisUserAccessCache, type UserAccessCache } from "./auth/user-access-cache.js";
import { UserAccessResolver, type UserAccessService } from "./auth/user-access-resolver.js";
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
import { registerCodebasesRoutes } from "./routes/codebases.js";
import { registerExtensionsRoutes } from "./routes/extensions.js";
import { registerInsightsRoutes } from "./routes/insights.js";
import { registerSecretsRoutes } from "./routes/secrets.js";
import { registerProfilesRoutes } from "./routes/profiles.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { ProjectScopeError } from "./utils/project-scope.js";
import { registerUsersRoutes } from "./routes/users.js";
import type { RouteContext } from "./route-context.js";
import type {
  CriteriaDocument,
  PromptFeatureDocument,
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
} from "./route-context.js";

dotenv.config();

// Initialize Application Insights telemetry (must be early to patch HTTP/DB libs)
initTelemetry("scope-api");

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
const queueReport = process.env.AZURE_STORAGE_QUEUE_REPORT || "report-queue";
const strictAgentCapabilities =
  process.env.SCOPE_STRICT_AGENT_CAPABILITIES?.toLowerCase() === "true";
const port = parseInt(process.env.PORT || "3000", 10);

// MongoDB clients
let mongoClient: MongoClient;
let db: Db;
let collection: Collection<RequestDocument>;
let runsCol: Collection<RunHistoryDocument>;
let projectCollection: Collection<ProjectDocument>;
let projectStore: ProjectStore;
let criteriaCollection: Collection<CriteriaDocument>;
let promptFeatureCollection: Collection<PromptFeatureDocument>;
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
let usersCollection: Collection<UserDocument>;
let authProvider: AuthProvider | null = null;
let profileEnricher: ProfileEnricher | null = null;
let userStore: UserStore | null = null;
let userAccessCache: UserAccessCache | null = null;
let userAccessResolver: UserAccessService | null = null;
let skillResolver: SkillResolver;
let codebaseCollection: Collection<CodebaseDocument>;
let codebaseRevisionCollection: Collection<CodebaseRevisionDocument>;
let codebaseStore: CodebaseStore;
let codebaseRevisionStore: CodebaseRevisionStore;
let codebaseResolver: CodebaseResolver;
let blobStorage: BlobStorage;
let heartbeatStore: HeartbeatStore;
let reportQueueClient: QueueClient;

async function initializeClients(): Promise<void> {
  // Connect to MongoDB
  mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  db = mongoClient.db(mongoDatabase);
  collection = db.collection<RequestDocument>(mongoCollection);
  runsCol = db.collection<RunHistoryDocument>("runs");
  projectCollection = db.collection<ProjectDocument>("projects");
  projectStore = new ProjectStore(projectCollection);
  criteriaCollection = db.collection<CriteriaDocument>("criteria");
  promptFeatureCollection = db.collection<PromptFeatureDocument>("prompt-features");
  reportCollection = db.collection<ReportDocument>("reports");
  agentCollection = db.collection<CodingAgentDocument>("agents");
  modelCollection = db.collection<ModelDocument>("models");
  mcpServerCollection = db.collection<McpServerDocument>("mcp-servers");
  insightsCollection = db.collection<InsightDocument>("insights");
  taskPromptCollection = db.collection<TaskPromptDocument>("task-prompts");
  // Blob storage is also (re)assigned below for logs/snapshots; construct an
  // instance here so the task-prompt store can offload over-threshold bodies.
  blobStorage = new BlobStorage({ storageAccountName, storageConnectionString });
  taskPromptStore = new TaskPromptStore(taskPromptCollection, blobStorage);
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

  usersCollection = db.collection<UserDocument>("users");
  const authRuntime = loadAuthConfigFromEnv();
  if (authRuntime) {
    authProvider = authRuntime.provider;
    profileEnricher = authRuntime.enricher;
    userStore = new UserStore(usersCollection, {
      bootstrapAdmins: authRuntime.bootstrapAdmins,
      bootstrapTenants: authRuntime.bootstrapTenants,
    });
    userAccessCache = new RedisUserAccessCache({
      redisHost: process.env.REDIS_HOST || "",
      redisPort: parseInt(process.env.REDIS_PORT || "6379", 10),
      redisPassword: process.env.REDIS_PASSWORD || "",
    }, {
      ttlSeconds: authRuntime.userCacheTtlSeconds,
      namespace: mongoDatabase,
    });
    userAccessResolver = new UserAccessResolver({
      userStore,
      cache: userAccessCache,
      enricher: profileEnricher,
    });
    console.log(`Auth enabled: provider=${authProvider.id}`);
  } else {
    console.log("Auth not configured — all requests will be treated as anonymous");
  }

  codebaseCollection = db.collection<CodebaseDocument>("codebases");
  codebaseRevisionCollection = db.collection<CodebaseRevisionDocument>("codebase-revisions");
  codebaseStore = new CodebaseStore(codebaseCollection);
  codebaseRevisionStore = new CodebaseRevisionStore(codebaseRevisionCollection, codebaseStore);
  codebaseResolver = new CodebaseResolver({
    tokenProvider: acquireGitHubPublicApiToken,
  });

  // Note: Collection indexes are managed by db-migrations (see 002-create-indexes.ts).
  // Run `pnpm migrate:up` to apply pending migrations.

  // Seed default feature flags (upsert — won't overwrite existing enabled state)
  const defaultFlags: Array<{ key: string; label: string; enabled?: boolean }> = [
    { key: "mcp", label: "MCP Servers" },
    { key: "models", label: "Models" },
    { key: "agents", label: "Agents" },
    { key: "tokens", label: "Tokens" },
    { key: "extensions", label: "VS Code Extensions" },
    { key: "statistics-graph", label: "Statistics Graph" },
    // Gate pipeline: Run and Deploy are not ready for users yet — hidden in the
    // portal by default. Backend/CLI stay permissive; flip these on in Admin
    // when ready. See apps/portal/src/lib/gates.ts (GATE_FEATURE_FLAGS).
    { key: "gates-run", label: "Run Gate", enabled: false },
    { key: "gates-deploy", label: "Deploy Gate", enabled: false },
  ];
  for (const flag of defaultFlags) {
    await featureFlagCollection.updateOne(
      { key: flag.key },
      { $setOnInsert: { key: flag.key, label: flag.label, enabled: flag.enabled ?? true, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  console.log(`Connected to MongoDB: ${mongoUri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);

  // Coding-agent queues are initialized by the scheduler from registry version
  // manifests. The API only owns the report-generation queue.
  if (storageConnectionString) {
    reportQueueClient = new QueueClient(storageConnectionString, queueReport);
  } else {
    const credential = new DefaultAzureCredential();
    const queueUrl = `https://${storageAccountName}.queue.core.windows.net`;
    reportQueueClient = new QueueClient(`${queueUrl}/${queueReport}`, credential);
  }

  await reportQueueClient.createIfNotExists();
  console.log(`Ensured queue exists: ${queueReport}`);

  // Initialize blob storage (used for log persistence and snapshots).
  // Already constructed above for the task-prompt store; reassign to keep the
  // original initialization order/comment intact.
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
  get projectCollection() { return projectCollection; },
  get criteriaCollection() { return criteriaCollection; },
  get promptFeatureCollection() { return promptFeatureCollection; },
  get reportCollection() { return reportCollection; },
  get reportTemplateCollection() { return reportTemplateCollection; },
  get agentCollection() { return agentCollection; },
  get modelCollection() { return modelCollection; },
  get mcpServerCollection() { return mcpServerCollection; },
  get mcpSecretClient() { return mcpSecretClient; },
  get insightsCollection() { return insightsCollection; },
  get profileCollection() { return profileCollection; },
  get profileVersionCollection() { return profileVersionCollection; },
  get usersCollection() { return usersCollection; },
  get userStore() { return userStore; },
  get userAccessResolver() { return userAccessResolver; },
  get authProvider() { return authProvider; },
  get profileEnricher() { return profileEnricher; },
  get taskPromptCollection() { return taskPromptCollection; },
  get featureFlagCollection() { return featureFlagCollection; },
  get skillCollection() { return skillCollection; },
  get extensionCollection() { return extensionCollection; },
  get skillRevisionCollection() { return skillRevisionCollection; },
  get taskPromptStore() { return taskPromptStore; },
  get skillRevisionStore() { return skillRevisionStore; },
  get skillResolver() { return skillResolver; },
  get codebaseCollection() { return codebaseCollection; },
  get codebaseRevisionCollection() { return codebaseRevisionCollection; },
  get codebaseStore() { return codebaseStore; },
  get codebaseRevisionStore() { return codebaseRevisionStore; },
  get codebaseResolver() { return codebaseResolver; },
  get projectStore() { return projectStore; },
  get reportQueueClient() { return reportQueueClient; },
  get blobStorage() { return blobStorage; },
  get heartbeatStore() { return heartbeatStore; },
  strictAgentCapabilities,
  storageConnectionString,
  storageAccountName,
};

// ─── Route registration ───────────────────────────────────────────────────────
app.use("/api/v1/users/me", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(
  createAuthMiddleware({
    getProvider: () => authProvider,
  }),
);
registerUsersRoutes(routeCtx);
app.use(createUserAccessMiddleware(() => userAccessResolver));

// Secrets/proxy routes must be registered first (before :id param routes)
registerSecretsRoutes(routeCtx);
registerSystemRoutes(routeCtx);
registerProjectsRoutes(routeCtx);
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
registerCodebasesRoutes(routeCtx);
registerExtensionsRoutes(routeCtx);
registerInsightsRoutes(routeCtx);
registerFeatureFlagRoutes(routeCtx);

// Error handler
app.use(authErrorHandler);
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ProjectScopeError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
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

  const server = app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((error) => {
      if (error) {
        console.error("Failed to close API server:", error);
        process.exitCode = 1;
      }
      void Promise.all([
        userAccessCache?.close(),
        heartbeatStore.close(),
        mongoClient.close(),
      ]).catch((closeError: unknown) => {
        console.error("Failed to close API dependencies:", closeError);
        process.exitCode = 1;
      });
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
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
  reportCollection?: Collection<ReportDocument>;
  agentCollection?: Collection<CodingAgentDocument>;
  modelCollection?: Collection<ModelDocument>;
  mcpServerCollection?: Collection<McpServerDocument>;
  insightsCollection?: Collection<InsightDocument>;
  profileCollection?: Collection<ProfileDocument>;
  profileVersionCollection?: Collection<ProfileVersionDocument>;
  usersCollection?: Collection<UserDocument>;
  userStore?: UserStore | null;
  userAccessResolver?: UserAccessService | null;
  authProvider?: AuthProvider | null;
  profileEnricher?: ProfileEnricher | null;
  taskPromptCollection?: Collection<TaskPromptDocument>;
  taskPromptStore?: TaskPromptStore;
  featureFlagCollection?: Collection<FeatureFlagDocument>;
  reportTemplateCollection?: Collection<ReportTemplateDocument>;
  skillCollection?: Collection<SkillDocument>;
  skillRevisionCollection?: Collection<SkillRevisionDocument>;
  skillRevisionStore?: SkillRevisionStore;
  skillResolver?: SkillResolver;
  codebaseCollection?: Collection<CodebaseDocument>;
  codebaseRevisionCollection?: Collection<CodebaseRevisionDocument>;
  codebaseStore?: CodebaseStore;
  codebaseRevisionStore?: CodebaseRevisionStore;
  codebaseResolver?: CodebaseResolver;
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
  if (deps.reportCollection) reportCollection = deps.reportCollection;
  if (deps.agentCollection) agentCollection = deps.agentCollection;
  if (deps.modelCollection) modelCollection = deps.modelCollection;
  if (deps.mcpServerCollection) mcpServerCollection = deps.mcpServerCollection;
  if (deps.insightsCollection) insightsCollection = deps.insightsCollection;
  if (deps.profileCollection) profileCollection = deps.profileCollection;
  if (deps.profileVersionCollection) profileVersionCollection = deps.profileVersionCollection;
  if (deps.usersCollection) usersCollection = deps.usersCollection;
  if (deps.userStore !== undefined) userStore = deps.userStore;
  if (deps.userAccessResolver !== undefined) userAccessResolver = deps.userAccessResolver;
  if (deps.authProvider !== undefined) authProvider = deps.authProvider;
  if (deps.profileEnricher !== undefined) profileEnricher = deps.profileEnricher;
  if (deps.taskPromptCollection) taskPromptCollection = deps.taskPromptCollection;
  if (deps.taskPromptStore) taskPromptStore = deps.taskPromptStore;
  if (deps.featureFlagCollection) featureFlagCollection = deps.featureFlagCollection;
  if (deps.reportTemplateCollection) reportTemplateCollection = deps.reportTemplateCollection;
  if (deps.skillCollection) skillCollection = deps.skillCollection;
  if (deps.skillRevisionCollection) skillRevisionCollection = deps.skillRevisionCollection;
  if (deps.skillRevisionStore) skillRevisionStore = deps.skillRevisionStore;
  if (deps.skillResolver) skillResolver = deps.skillResolver;
  if (deps.codebaseCollection) codebaseCollection = deps.codebaseCollection;
  if (deps.codebaseRevisionCollection) codebaseRevisionCollection = deps.codebaseRevisionCollection;
  if (deps.codebaseStore) codebaseStore = deps.codebaseStore;
  if (deps.codebaseRevisionStore) codebaseRevisionStore = deps.codebaseRevisionStore;
  if (deps.codebaseResolver) codebaseResolver = deps.codebaseResolver;
  if (deps.reportQueueClient) reportQueueClient = deps.reportQueueClient;
  if (deps.blobStorage) blobStorage = deps.blobStorage;
}

// ─── Start server when executed directly ─────────────────────────────────────

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
