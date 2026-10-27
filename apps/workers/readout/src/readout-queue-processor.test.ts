// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { DequeuedMessageItem } from "@azure/storage-queue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPERIMENT_STORAGE_PROFILE_VERSION,
  ExperimentStore,
  type CriteriaDocument,
  type ExperimentDocument,
  type RequestDocument,
  type RunHistoryDocument,
  type VisibilityHeartbeat,
} from "shared";

const generate = vi.hoisted(() => vi.fn());
vi.mock("./readout-generator.js", () => ({
  generateExperimentReadout: generate,
}));

import { ReadoutQueueProcessor } from "./readout-queue-processor.js";

const now = new Date("2026-10-13T12:00:00.000Z");
const experiment: ExperimentDocument = {
  _id: "experiment-1",
  experimentId: "experiment-1",
  projectId: "project-1",
  metadata: { name: "Experiment" },
  storageProfileVersion: EXPERIMENT_STORAGE_PROFILE_VERSION,
  stateVersion: 1,
  revision: {
    experimentRevisionId: "revision-1",
    revisionNumber: 1,
    memberCount: 1,
    membershipFingerprint: "membership",
    definitionFingerprint: "definition",
    createdAt: now,
  },
  execution: {
    experimentExecutionId: "execution-1",
    attemptNumber: 1,
    version: 2,
    requests: {
      storage: "inline",
      entryCount: 1,
      payloadFingerprint: "payload",
      payloadVersion: 1,
      entries: [{
        requestId: "request-1",
        runId: "run-1",
        dependencies: [{ handlerId: "pp-observations", state: "ready" }],
        blockers: [],
      }],
    },
    vectorFingerprint: "vector",
    handlerSummary: {
      "pp-readout": {
        status: "processing",
        version: 1,
        claimToken: "claim-1",
        updatedAt: now,
      },
    },
    blocking: [],
    createdAt: now,
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

const payload = {
  type: "readout",
  projectId: experiment.projectId,
  experimentId: experiment.experimentId,
  experimentExecutionId: experiment.execution.experimentExecutionId,
  handlerId: "pp-readout",
  handlerVersion: 1,
  claimToken: "claim-1",
  executionVersion: 1,
};
type ReadoutPayload = typeof payload;

const message = { messageId: "message-1" } as DequeuedMessageItem;
const heartbeat = {
  stop: vi.fn().mockResolvedValue(undefined),
} as unknown as VisibilityHeartbeat;

function processor() {
  const instance = new ReadoutQueueProcessor({
    mongoUri: "mongodb://localhost:27017",
    mongoDatabase: "scope",
    mongoCollection: "experiments",
    storageAccountName: "devstoreaccount1",
    storageConnectionString: "UseDevelopmentStorage=true",
    queueName: "pp-readout-queue",
    batchSize: 1,
    pollIntervalMs: 100,
    redisHost: "localhost",
    redisPort: 6379,
    redisPassword: "",
    model: "test-model",
    sessionTimeoutMs: 1_000,
  });
  const insertOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const uploadJson = vi.fn().mockResolvedValue(
    "https://storage.example/reports/report/structured.json",
  );
  const safeDeleteMessage = vi.fn().mockResolvedValue(undefined);
  Object.assign(instance as object, {
    collection: {},
    db: {
      collection: vi.fn((name: string) =>
        name === "reports" ? { insertOne } : {}
      ),
    },
    loadEvidence: vi.fn().mockResolvedValue({
      experimentId: experiment.experimentId,
      experimentExecutionId: experiment.execution.experimentExecutionId,
      runs: [],
    }),
    tokenClient: {
      acquireToken: vi.fn().mockResolvedValue("token"),
    },
    blobStorage: { uploadJson },
    safeDeleteMessage,
  });
  return { instance, insertOne, uploadJson, safeDeleteMessage };
}

async function handle(instance: ReadoutQueueProcessor, log = vi.fn()) {
  await (instance as unknown as {
    handleRequest(
      experiment: ExperimentDocument,
      message: DequeuedMessageItem,
      heartbeat: VisibilityHeartbeat,
      log: ReturnType<typeof vi.fn>,
      payload: ReadoutPayload,
    ): Promise<void>;
  }).handleRequest(experiment, message, heartbeat, log, payload);
}

describe("readout queue orchestration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    generate.mockReset();
    generate.mockResolvedValue({
      meta: {
        schemaId: "scope.experiment-readout",
        schemaVersion: "1.0",
        generatedAt: now.toISOString(),
        experimentId: experiment.experimentId,
        experimentExecutionId: experiment.execution.experimentExecutionId,
      },
      summary: {
        title: "Experiment readout",
        executiveSummary: "Summary",
        totalRuns: 1,
        succeededRuns: 0,
        failedRuns: 1,
        passedObservations: 0,
        failedObservations: 1,
      },
      profiles: [],
      runs: [],
      findings: [],
      actions: [],
    });
  });

  it("discards stale or duplicate exact-execution messages before generation", async () => {
    vi.spyOn(ExperimentStore.prototype, "claimHandler").mockResolvedValue(null);
    const { instance, insertOne, safeDeleteMessage } = processor();

    await handle(instance);

    expect(generate).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
    expect(safeDeleteMessage).toHaveBeenCalledOnce();
  });

  it("publishes the report reference with final handler completion in one CAS", async () => {
    vi.spyOn(ExperimentStore.prototype, "claimHandler").mockResolvedValue(experiment);
    vi.spyOn(ExperimentStore.prototype, "get").mockResolvedValue(experiment);
    const complete = vi
      .spyOn(ExperimentStore.prototype, "completeHandler")
      .mockResolvedValue(experiment);
    const { instance, insertOne } = processor();

    await handle(instance);

    expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({
      experimentId: experiment.experimentId,
      experimentExecutionId: experiment.execution.experimentExecutionId,
      status: "completed",
    }));
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      expectedExecutionVersion: experiment.execution.version,
      status: "done",
      report: expect.objectContaining({
        reportId: expect.any(String),
      }),
    }));
  });

  it("keeps an inserted report historical when work is superseded in flight", async () => {
    vi.spyOn(ExperimentStore.prototype, "claimHandler").mockResolvedValue(experiment);
    vi.spyOn(ExperimentStore.prototype, "get")
      .mockResolvedValueOnce(experiment)
      .mockResolvedValueOnce(experiment)
      .mockResolvedValueOnce(experiment)
      .mockResolvedValueOnce(experiment)
      .mockResolvedValueOnce(experiment)
      .mockResolvedValueOnce(null);
    const complete = vi.spyOn(ExperimentStore.prototype, "completeHandler");
    const { instance, insertOne } = processor();
    const log = vi.fn().mockResolvedValue(undefined);

    await handle(instance, log);

    expect(insertOne).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "warn",
      "Readout report remained historical after supersession",
      expect.objectContaining({
        experimentId: experiment.experimentId,
        experimentExecutionId: experiment.execution.experimentExecutionId,
      }),
    );
  });

  it("loads the archived run named by the immutable exact execution vector", async () => {
    const { instance } = processor();
    delete (instance as unknown as Record<string, unknown>).loadEvidence;
    vi.spyOn(ExperimentStore.prototype, "readExecutionRequests")
      .mockResolvedValue([{
        requestId: "request-1",
        runId: "run-1",
        dependencies: [{ handlerId: "pp-observations", state: "ready" }],
        blockers: [],
      }]);
    const request = {
      _id: "request-1",
      projectId: "project-1",
      workerType: "coder-acp-copilot",
      observations: ["observation-criterion"],
      scenario: { task: "Task", criteria: ["task-criterion"] },
      createdAt: now,
      priority: 0,
      run: {
        _id: "run-newer",
        attemptNumber: 2,
        status: "done",
        outcome: "succeeded",
      },
    } satisfies RequestDocument;
    const archivedRun = {
      _id: "run-1",
      requestId: "request-1",
      projectId: "project-1",
      attemptNumber: 1,
      status: "done",
      outcome: "failed",
      observationResults: [{
        criterionId: "result-criterion",
        evaluated: true,
        passed: false,
        feedback: "Archived evidence",
      }],
    } satisfies RunHistoryDocument;
    const criteria = [
      {
        id: "task-criterion",
        prompt: "Task criterion",
        projectId: "project-1",
        createdAt: now,
      },
      {
        id: "observation-criterion",
        prompt: "Configured observation",
        projectId: "project-1",
        createdAt: now,
      },
      {
        id: "result-criterion",
        prompt: "Archived observation result",
        projectId: "project-1",
        createdAt: now,
      },
    ] satisfies CriteriaDocument[];
    const historyFindOne = vi.fn().mockResolvedValue(archivedRun);
    const criteriaFind = vi.fn(() => ({
      toArray: vi.fn().mockResolvedValue(criteria),
    }));
    Object.assign(instance as object, {
      db: {
        collection: vi.fn((name: string) => {
          if (name === "requests") {
            return {
              find: vi.fn(() => ({
                toArray: vi.fn().mockResolvedValue([request]),
              })),
            };
          }
          if (name === "runs") return { findOne: historyFindOne };
          if (name === "criteria") return { find: criteriaFind };
          return {};
        }),
      },
    });

    const evidence = await (instance as unknown as {
      loadEvidence(value: typeof payload): Promise<{
        runs: Array<{ run: RunHistoryDocument }>;
      }>;
    }).loadEvidence(payload);

    expect(historyFindOne).toHaveBeenCalledWith({
      _id: "run-1",
      requestId: "request-1",
      projectId: "project-1",
    });
    expect(evidence.runs[0]?.run._id).toBe("run-1");
    expect(evidence.runs[0]?.run.outcome).toBe("failed");
    expect(evidence.runs[0]?.run.observationResults?.[0]).toMatchObject({
      passed: false,
      feedback: "Archived evidence",
    });
  });
});
