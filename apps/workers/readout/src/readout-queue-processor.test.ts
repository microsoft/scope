// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { DequeuedMessageItem } from "@azure/storage-queue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CriteriaDocument,
  SubmissionDocument,
  VisibilityHeartbeat,
} from "shared";
import type { RequestDocument, RunHistoryDocument } from "shared";

const coordination = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  isCurrent: vi.fn(),
}));
const generate = vi.hoisted(() => vi.fn());

vi.mock("shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("shared")>()),
  claimSubmissionHandler: coordination.claim,
  completeSubmissionHandler: coordination.complete,
  isCurrentSubmissionRun: coordination.isCurrent,
}));
vi.mock("./readout-generator.js", () => ({
  generateSubmissionReadout: generate,
}));

import { ReadoutQueueProcessor } from "./readout-queue-processor.js";

const submission: SubmissionDocument = {
  _id: "submission-1",
  submissionId: "submission-1",
  projectId: "project-1",
  requestIds: ["request-1"],
  run: {
    _id: "submission-run-1",
    attemptNumber: 1,
    vectorFingerprint: "request-1:run-1",
    requests: [{ requestId: "request-1", runId: "run-1" }],
    dependencyProjection: [],
    handlerStatus: {
      "pp-readout": {
        version: 1,
        status: "processing",
        updatedAt: new Date("2026-10-13T12:00:00.000Z"),
      },
    },
    blocking: [],
    createdAt: new Date("2026-10-13T12:00:00.000Z"),
    startedAt: new Date("2026-10-13T12:00:00.000Z"),
    updatedAt: new Date("2026-10-13T12:00:00.000Z"),
  },
  createdAt: new Date("2026-10-13T12:00:00.000Z"),
  updatedAt: new Date("2026-10-13T12:00:00.000Z"),
};

function processor() {
  const instance = new ReadoutQueueProcessor({
    mongoUri: "mongodb://localhost:27017",
    mongoDatabase: "scope",
    mongoCollection: "submissions",
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
  Object.assign(instance as object, {
    collection: {},
    db: {
      collection: vi.fn((name: string) =>
        name === "reports" ? { insertOne } : {}
      ),
    },
    loadEvidence: vi.fn().mockResolvedValue({
      submissionId: submission._id,
      submissionRunId: submission.run._id,
      runs: [],
    }),
    tokenClient: {
      acquireToken: vi.fn().mockResolvedValue("token"),
    },
    blobStorage: {
      uploadJson: vi.fn().mockImplementation((path: string) =>
        Promise.resolve(`https://storage.example/${path}`)
      ),
    },
    safeDeleteMessage: vi.fn().mockResolvedValue(undefined),
  });
  return { instance, insertOne };
}

const message = { messageId: "message-1" } as DequeuedMessageItem;
const heartbeat = {
  stop: vi.fn().mockResolvedValue(undefined),
} as unknown as VisibilityHeartbeat;
const payload = {
  type: "readout",
  submissionId: submission._id,
  submissionRunId: submission.run._id,
};
type LogFn = ReturnType<typeof vi.fn>;
type ReadoutPayload = typeof payload;

async function handle(instance: ReadoutQueueProcessor, log: LogFn = vi.fn()) {
  await (instance as unknown as {
    handleRequest(
      submission: SubmissionDocument,
      message: DequeuedMessageItem,
      heartbeat: VisibilityHeartbeat,
      log: LogFn,
      payload: ReadoutPayload,
    ): Promise<void>;
  }).handleRequest(submission, message, heartbeat, log, payload);
}

describe("readout queue orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coordination.isCurrent.mockResolvedValue(true);
    generate.mockResolvedValue({
      meta: {
        schemaId: "scope.submission-readout",
        schemaVersion: "1.0",
        generatedAt: "2026-10-13T12:00:00.000Z",
        submissionId: submission._id,
        submissionRunId: submission.run._id,
      },
      summary: {
        title: "Submission readout",
        executiveSummary: "Summary",
        totalRuns: 0,
        succeededRuns: 0,
        failedRuns: 0,
        passedObservations: 0,
        failedObservations: 0,
      },
      profiles: [],
      runs: [],
      findings: [],
      actions: [],
    });
  });

  it("discards stale or duplicate exact-run messages before generation", async () => {
    coordination.claim.mockResolvedValue(null);
    const { instance, insertOne } = processor();

    await handle(instance);

    expect(generate).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
    expect((instance as unknown as { safeDeleteMessage: ReturnType<typeof vi.fn> })
      .safeDeleteMessage).toHaveBeenCalledOnce();
  });

  it("keeps superseded completions historical and uses new report ids on retry", async () => {
    coordination.claim.mockResolvedValue(submission);
    coordination.complete.mockResolvedValue(false);
    const { instance, insertOne } = processor();
    const log = vi.fn().mockResolvedValue(undefined);

    await handle(instance, log);
    await handle(instance, log);

    expect(insertOne).toHaveBeenCalledTimes(2);
    const reports = insertOne.mock.calls.map(([report]) => report);
    expect(reports[0]._id).not.toBe(reports[1]._id);
    expect(reports).toEqual([
      expect.objectContaining({
        submissionId: submission._id,
        submissionRunId: submission.run._id,
      }),
      expect.objectContaining({
        submissionId: submission._id,
        submissionRunId: submission.run._id,
      }),
    ]);
    expect(coordination.complete).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "Readout report remained historical after supersession",
      expect.objectContaining({
        submissionId: submission._id,
        submissionRunId: submission.run._id,
      }),
    );
  });

  it("does not publish when the submission is superseded during upload", async () => {
    coordination.claim.mockResolvedValue(submission);
    coordination.isCurrent
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { instance, insertOne } = processor();

    await handle(instance);

    expect(generate).toHaveBeenCalledOnce();
    expect(insertOne).not.toHaveBeenCalled();
    expect(coordination.complete).not.toHaveBeenCalled();
  });

  it("loads the archived run named by the immutable exact vector", async () => {
    const { instance } = processor();
    delete (instance as unknown as Record<string, unknown>).loadEvidence;
    const currentRequest = {
      _id: "request-1",
      projectId: "project-1",
      workerType: "coder-acp-copilot",
      observations: ["observation-criterion"],
      scenario: { task: "Task", criteria: ["task-criterion"] },
      createdAt: new Date("2026-10-13T12:00:00.000Z"),
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
    const historyFindOne = vi.fn().mockResolvedValue(archivedRun);
    const criteria = [
      {
        id: "task-criterion",
        prompt: "Task criterion",
        projectId: "project-1",
        createdAt: new Date("2026-10-13T12:00:00.000Z"),
      },
      {
        id: "observation-criterion",
        prompt: "Configured observation",
        projectId: "project-1",
        createdAt: new Date("2026-10-13T12:00:00.000Z"),
      },
      {
        id: "result-criterion",
        prompt: "Archived observation result",
        projectId: "project-1",
        createdAt: new Date("2026-10-13T12:00:00.000Z"),
      },
    ] satisfies CriteriaDocument[];
    const criteriaFind = vi.fn(() => ({
      toArray: vi.fn().mockResolvedValue(criteria),
    }));
    Object.assign(instance as object, {
      db: {
        collection: vi.fn((name: string) => {
          if (name === "requests") {
            return {
              find: vi.fn(() => ({
                toArray: vi.fn().mockResolvedValue([currentRequest]),
              })),
            };
          }
          if (name === "runs") return { findOne: historyFindOne };
          if (name === "criteria") {
            return { find: criteriaFind };
          }
          return {};
        }),
      },
    });

    const evidence = await (instance as unknown as {
      loadEvidence(value: SubmissionDocument): Promise<{
        runs: Array<{
          run: RunHistoryDocument | RequestDocument["run"];
          criteria: CriteriaDocument[];
        }>;
      }>;
    }).loadEvidence(submission);

    expect(historyFindOne).toHaveBeenCalledWith({
      _id: "run-1",
      requestId: "request-1",
      projectId: "project-1",
    });
    expect(evidence.runs[0].run?._id).toBe("run-1");
    expect(evidence.runs[0].criteria.map((criterion) => criterion.id)).toEqual([
      "task-criterion",
      "observation-criterion",
      "result-criterion",
    ]);
    expect(criteriaFind).toHaveBeenCalledWith({
      projectId: "project-1",
      id: {
        $in: expect.arrayContaining([
          "task-criterion",
          "observation-criterion",
          "result-criterion",
        ]),
      },
    });
  });
});
