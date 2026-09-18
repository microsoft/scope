// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { vi } from "vitest";
import type {
  Collection,
  Db,
  Document,
} from "mongodb";
import type { BlobStorage } from "shared";
import type { TestDependencies } from "./index.js";

// ---------------------------------------------------------------------------
// Mock MongoDB collection
// ---------------------------------------------------------------------------

export function createMockCollection<T extends Document = Document>(docs: T[] = []): Collection<T> {
  const data = [...docs];

  const mockCursor = {
    toArray: vi.fn().mockResolvedValue(data),
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
  };

  return {
    find: vi.fn().mockReturnValue(mockCursor),
    findOne: vi.fn().mockImplementation((filter: any) => {
      const id =
        filter?._id ?? filter?.id ?? filter?.key;
      if (id) {
        return Promise.resolve(
          data.find(
            (d: any) => d._id === id || d.id === id || d.key === id,
          ) || null,
        );
      }
      return Promise.resolve(data[0] || null);
    }),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
    insertOne: vi.fn().mockResolvedValue({
      insertedId: "mock-id",
      acknowledged: true,
    }),
    insertMany: vi.fn().mockResolvedValue({
      insertedCount: 1,
      acknowledged: true,
    }),
    updateOne: vi.fn().mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
      acknowledged: true,
    }),
    updateMany: vi.fn().mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
      acknowledged: true,
    }),
    deleteOne: vi.fn().mockResolvedValue({
      deletedCount: 1,
      acknowledged: true,
    }),
    deleteMany: vi.fn().mockResolvedValue({
      deletedCount: 0,
      acknowledged: true,
    }),
    countDocuments: vi.fn().mockResolvedValue(data.length),
    estimatedDocumentCount: vi.fn().mockResolvedValue(data.length),
    aggregate: vi
      .fn()
      .mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    createIndex: vi.fn().mockResolvedValue("index_name"),
    indexes: vi.fn().mockResolvedValue([]),
    watch: vi.fn().mockReturnValue({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Collection<T>;
}

// ---------------------------------------------------------------------------
// Mock Db
// ---------------------------------------------------------------------------

export function createMockDb(): Db {
  return {
    collection: vi.fn().mockReturnValue(createMockCollection()),
    command: vi.fn().mockResolvedValue({ ok: 1 }),
  } as unknown as Db;
}

// ---------------------------------------------------------------------------
// Mock QueueClient
// ---------------------------------------------------------------------------

export function createMockQueueClient(): Record<string, any> {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
    createIfNotExists: vi.fn().mockResolvedValue(undefined),
    receiveMessages: vi.fn().mockResolvedValue({ receivedMessageItems: [] }),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Mock TaskPromptStore
// ---------------------------------------------------------------------------

export function createMockTaskPromptStore(): Record<string, any> {
  return {
    get: vi.fn().mockResolvedValue(null),
    getByText: vi.fn().mockResolvedValue(null),
    findOrCreate: vi.fn().mockResolvedValue({
      _id: "tp-mock-id",
      text: "mock task",
      createdAt: new Date(),
    }),
    getAll: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    resolvePromptText: vi.fn().mockResolvedValue("mock task"),
    delete: vi.fn().mockResolvedValue(undefined),
    attachFeatures: vi.fn().mockResolvedValue({
      _id: "tp-mock-id",
      text: "mock task",
      features: [],
      featuresExtractedAt: new Date(),
      createdAt: new Date(),
    }),
    toggleFeature: vi.fn().mockResolvedValue({
      _id: "tp-mock-id",
      text: "mock task",
      features: [],
      createdAt: new Date(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock SkillRevisionStore / SkillResolver
// ---------------------------------------------------------------------------

export function createMockSkillRevisionStore(): Record<string, any> {
  return {
    get: vi.fn().mockResolvedValue(null),
    getByRef: vi.fn().mockResolvedValue(null),
    listBySkill: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteBySkill: vi.fn().mockResolvedValue(undefined),
  };
}

export function createMockSkillResolver(): Record<string, any> {
  return {
    resolve: vi.fn().mockResolvedValue({ ref: "mock-ref" }),
    discoverSkills: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Mock BlobStorage
// ---------------------------------------------------------------------------

export function createMockBlobStorage(): BlobStorage {
  return {
    getLogEvents: vi.fn().mockResolvedValue([]),
    getLogsBlobUrl: vi.fn().mockImplementation((blobName: string) => `https://mockaccount.blob.core.windows.net/logs/${blobName}`),
    appendLogEvent: vi.fn().mockResolvedValue(undefined),
    ensureContainer: vi.fn().mockResolvedValue(undefined),
    uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot"),
    downloadSnapshot: vi.fn().mockResolvedValue(undefined),
    listSnapshots: vi.fn().mockResolvedValue([]),
  } as unknown as BlobStorage;
}

// ---------------------------------------------------------------------------
// Aggregate: creates every mock dependency _injectTestDependencies accepts
// ---------------------------------------------------------------------------

export function createAllMockDependencies() {
  const db = createMockDb();
  const collection = createMockCollection();
  const runsCollection = createMockCollection();
  const criteriaCollection = createMockCollection();
  const promptFeatureCollection = createMockCollection();
  const reportCollection = createMockCollection();
  const agentCollection = createMockCollection();
  const modelCollection = createMockCollection();
  const mcpServerCollection = createMockCollection();
  const insightsCollection = createMockCollection();
  const taskPromptCollection = createMockCollection();
  const featureFlagCollection = createMockCollection();
  const reportTemplateCollection = createMockCollection();
  const skillCollection = createMockCollection();
  const skillRevisionCollection = createMockCollection();
  const profileCollection = createMockCollection();
  const profileVersionCollection = createMockCollection();
  const usersCollection = createMockCollection();
  const taskPromptStore = createMockTaskPromptStore();
  const skillRevisionStore = createMockSkillRevisionStore();
  const skillResolver = createMockSkillResolver();
  const reportQueueClient = createMockQueueClient();
  const blobStorage = createMockBlobStorage();

  return {
    db,
    collection,
    runsCollection,
    criteriaCollection,
    promptFeatureCollection,
    reportCollection,
    agentCollection,
    modelCollection,
    mcpServerCollection,
    insightsCollection,
    taskPromptCollection,
    featureFlagCollection,
    reportTemplateCollection,
    skillCollection,
    skillRevisionCollection,
    profileCollection,
    profileVersionCollection,
    usersCollection,
    authProvider: null,
    userAccessResolver: null,
    taskPromptStore,
    skillRevisionStore,
    skillResolver,
    reportQueueClient,
    blobStorage,
  } as unknown as TestDependencies & {
    // Expose typed mocks for fine-grained stubbing
    db: ReturnType<typeof createMockDb>;
    collection: Collection;
    runsCollection: Collection;
    criteriaCollection: Collection;
    promptFeatureCollection: Collection;
    reportCollection: Collection;
    agentCollection: Collection;
    modelCollection: Collection;
    mcpServerCollection: Collection;
    insightsCollection: Collection;
    taskPromptCollection: Collection;
    featureFlagCollection: Collection;
    reportTemplateCollection: Collection;
    skillCollection: Collection;
    skillRevisionCollection: Collection;
    profileCollection: Collection;
    profileVersionCollection: Collection;
    usersCollection: Collection;
    taskPromptStore: ReturnType<typeof createMockTaskPromptStore>;
    skillRevisionStore: ReturnType<typeof createMockSkillRevisionStore>;
    skillResolver: ReturnType<typeof createMockSkillResolver>;
    reportQueueClient: ReturnType<typeof createMockQueueClient>;
    blobStorage: ReturnType<typeof createMockBlobStorage>;
  };
}
