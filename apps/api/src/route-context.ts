// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { z } from "zod";
import type { Collection, Db } from "mongodb";
import type { Express } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { QueueClient } from "@azure/storage-queue";
import type { BlobStorage } from "shared";
import type { HeartbeatStore } from "shared";
import type { UserStore } from "./auth/user-store.js";
import type { UserAccessService } from "./auth/user-access-resolver.js";
import type {
  TaskPromptStore,
  TaskPromptDocument,
  SkillRevisionStore,
  SkillResolver,
  SkillDocument,
  SkillRevisionDocument,
  CodebaseStore,
  CodebaseRevisionStore,
  CodebaseResolver,
  CodebaseDocument,
  CodebaseRevisionDocument,
  McpSecretClient,
  ProfileDocument,
  ProfileVersionDocument,
  ProjectStore,
  ProjectDocument,
  UserDocument,
  AuthProvider,
  ProfileEnricher,
  // Zod response schemas → inferred types replace hand-written interfaces
  CriteriaResponseSchema,
  ExtensionResponseSchema,
  PromptFeatureResponseSchema,
  InsightReferenceSchema,
  LogEventSchema,
  ReportResponseSchema,
  InsightResponseSchema,
  AgentVersionSchema,
  AgentResponseSchema,
  ModelResponseSchema,
  McpServerResponseSchema,
  FeatureFlagResponseSchema,
  ReportTriggerSchema,
  ReportTemplateResponseSchema,
  RequestResponseSchema,
  RunHistoryDocumentSchema,
} from "shared";

// ─── Document types (inferred from Zod schemas) ─────────────────────────────

export type CriteriaDocument = z.infer<typeof CriteriaResponseSchema>;
export type PromptFeatureDocument = z.infer<typeof PromptFeatureResponseSchema>;
export type InsightReference = z.infer<typeof InsightReferenceSchema>;
export type LogEvent = z.infer<typeof LogEventSchema>;
export type ReportDocument = z.infer<typeof ReportResponseSchema>;
export type InsightDocument = z.infer<typeof InsightResponseSchema>;
export type AgentVersion = z.infer<typeof AgentVersionSchema>;
export type CodingAgentDocument = z.infer<typeof AgentResponseSchema>;
export type ModelDocument = z.infer<typeof ModelResponseSchema>;
export type McpServerDocument = z.infer<typeof McpServerResponseSchema>;
export type ExtensionDocument = z.infer<typeof ExtensionResponseSchema>;
export type FeatureFlagDocument = z.infer<typeof FeatureFlagResponseSchema>;

export type ReportTrigger = z.infer<typeof ReportTriggerSchema>;
// Omit _id — MongoDB auto-generates it; the document type only uses `id`
export type ReportTemplateDocument = Omit<z.infer<typeof ReportTemplateResponseSchema>, "_id">;
export type RequestDocument = z.infer<typeof RequestResponseSchema>;
export type RunHistoryDocument = z.infer<typeof RunHistoryDocumentSchema>;

export type WorkerType = string;

// ─── RouteContext ────────────────────────────────────────────────────────────

/**
 * Dependency-injection context passed to route registration functions.
 * Contains all DB collections, services, and infrastructure the handlers need.
 */
export interface RouteContext {
  // Express + OpenAPI
  app: Express;
  registry: OpenAPIRegistry;

  // MongoDB
  db: Db;
  requestCollection: Collection<RequestDocument>;
  runsCollection: Collection<RunHistoryDocument>;
  projectCollection: Collection<ProjectDocument>;
  criteriaCollection: Collection<CriteriaDocument>;
  promptFeatureCollection: Collection<PromptFeatureDocument>;
  reportCollection: Collection<ReportDocument>;
  reportTemplateCollection: Collection<ReportTemplateDocument>;
  agentCollection: Collection<CodingAgentDocument>;
  modelCollection: Collection<ModelDocument>;
  mcpServerCollection: Collection<McpServerDocument>;
  insightsCollection: Collection<InsightDocument>;
  taskPromptCollection: Collection<TaskPromptDocument>;
  featureFlagCollection: Collection<FeatureFlagDocument>;
  skillCollection: Collection<SkillDocument>;
  extensionCollection: Collection<ExtensionDocument>;
  skillRevisionCollection: Collection<SkillRevisionDocument>;
  profileCollection: Collection<ProfileDocument>;
  profileVersionCollection: Collection<ProfileVersionDocument>;
  usersCollection: Collection<UserDocument>;
  codebaseCollection: Collection<CodebaseDocument>;
  codebaseRevisionCollection: Collection<CodebaseRevisionDocument>;

  // Services
  taskPromptStore: TaskPromptStore;
  skillRevisionStore: SkillRevisionStore;
  skillResolver: SkillResolver;
  codebaseStore: CodebaseStore;
  codebaseRevisionStore: CodebaseRevisionStore;
  codebaseResolver: CodebaseResolver;
  projectStore: ProjectStore;

  // Token Manager client (null when TOKEN_MANAGER_URL not set)
  mcpSecretClient: McpSecretClient | null;

  authProvider: AuthProvider | null;
  profileEnricher: ProfileEnricher | null;
  userStore: UserStore | null;
  userAccessResolver: UserAccessService | null;

  // Blob storage (log persistence + snapshots)
  blobStorage: BlobStorage;

  // Per-run liveness heartbeat store (Redis-backed). Used by the runs
  // routes to enrich `processing` responses with `run.lastHeartbeatAt`.
  heartbeatStore: HeartbeatStore;

  // Report generation remains an API-owned queue. Coding-agent queues are
  // discovered and owned by the scheduler from the agent registry.
  reportQueueClient: QueueClient;

  // Config
  strictAgentCapabilities: boolean;
  storageConnectionString: string;
  storageAccountName: string;
}
