// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import type { Collection } from "mongodb";
import type {
  RequestDocument,
  ServiceHandlerDocument,
  SubmissionDocument,
  SubmissionRunHistoryDocument,
} from "../types/types.js";
import {
  SubmissionCoordinator,
  claimSubmissionHandler,
  completeSubmissionHandler,
  ensureNativeSubmission,
} from "./submission-coordinator.js";

function queryResult<T>(items: T[]) {
  return {
    project: () => queryResult(items),
    sort: () => queryResult(items),
    limit: () => queryResult(items),
    toArray: async () => items,
  };
}

describe("submission coordinator persistence", () => {
  it("creates a native submission idempotently with the exact initial vector", async () => {
    let stored: SubmissionDocument | null = null;
    const updateOne = vi.fn(async (
      _filter: unknown,
      update: { $setOnInsert: SubmissionDocument },
    ) => {
      stored ??= update.$setOnInsert;
      return { matchedCount: stored ? 1 : 0, modifiedCount: 0 };
    });
    const findOne = vi.fn(async () => stored);
    const submissions = {
      updateOne,
      findOne,
    } as unknown as Collection<SubmissionDocument>;

    const first = await ensureNativeSubmission({
      collections: { submissions },
      submissionId: "submission-1",
      projectId: "project-1",
      requests: [
        { requestId: "request-1", runId: "run-1" },
        { requestId: "request-2", runId: "run-2" },
      ],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const second = await ensureNativeSubmission({
      collections: { submissions },
      submissionId: "submission-1",
      projectId: "project-1",
      requests: [
        { requestId: "request-1", runId: "run-1" },
        { requestId: "request-2", runId: "run-2" },
      ],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(first).toEqual(second);
    expect(first.requestIds).toEqual(["request-1", "request-2"]);
    expect(first.run.requests).toEqual([
      { requestId: "request-1", runId: "run-1" },
      { requestId: "request-2", runId: "run-2" },
    ]);
    expect(first.run._id).toBe(second.run._id);
    expect(updateOne).toHaveBeenCalledTimes(2);
  });

  it("rejects an idempotency key reused with a different immutable vector", async () => {
    const stored: SubmissionDocument = {
      _id: "submission-1",
      submissionId: "submission-1",
      projectId: "project-1",
      requestIds: ["request-1"],
      createdAt: new Date(),
      run: {
        _id: "submission-run-1",
        attemptNumber: 1,
        vectorFingerprint: "fingerprint",
        requests: [{ requestId: "request-1", runId: "run-1" }],
        createdAt: new Date(),
        dependencyProjection: [],
        blocking: [],
      },
    };
    const submissions = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 0 })),
      findOne: vi.fn(async () => stored),
    } as unknown as Collection<SubmissionDocument>;

    await expect(
      ensureNativeSubmission({
        collections: { submissions },
        submissionId: "submission-1",
        projectId: "project-1",
        requests: [{ requestId: "request-1", runId: "different-run" }],
      }),
    ).rejects.toThrow("different immutable request vector");
  });

  it("scopes claims and completions to the exact embedded submission run", async () => {
    const findOneAndUpdate = vi.fn(async (_filter: unknown, _update: unknown) => null);
    const updateOne = vi.fn(async (_filter: unknown, _update: unknown) => ({
      modifiedCount: 0,
    }));
    const submissions = {
      findOneAndUpdate,
      updateOne,
    } as unknown as Collection<SubmissionDocument>;

    expect(
      await claimSubmissionHandler({
        submissions,
        submissionId: "submission-1",
        submissionRunId: "stale-run",
        handlerId: "pp-readout",
        version: 1,
      }),
    ).toBeNull();
    expect(findOneAndUpdate.mock.calls[0]?.[0]).toMatchObject({
      _id: "submission-1",
      "run._id": "stale-run",
      "run.rollover": { $exists: false },
    });

    expect(
      await completeSubmissionHandler({
        submissions,
        submissionId: "submission-1",
        submissionRunId: "stale-run",
        handlerId: "pp-readout",
        status: "done",
        version: 1,
      }),
    ).toBe(false);
    expect(updateOne.mock.calls[0]?.[0]).toMatchObject({
      _id: "submission-1",
      "run._id": "stale-run",
      "run.rollover": { $exists: false },
      "run.handlerStatus.pp-readout.status": "processing",
    });
  });

  it("defers reconciliation while a bulk retry replaces its request vector", async () => {
    const submission: SubmissionDocument = {
      _id: "submission-1",
      submissionId: "submission-1",
      projectId: "project-1",
      requestIds: ["request-1"],
      createdAt: new Date(),
      run: {
        _id: "submission-run-1",
        attemptNumber: 1,
        vectorFingerprint: "old-vector",
        requests: [{ requestId: "request-1", runId: "run-1" }],
        createdAt: new Date(),
        reconcileAfter: new Date(Date.now() + 60_000),
        dependencyProjection: [],
        blocking: [],
      },
    };
    const requestsFind = vi.fn();
    const archiveInsert = vi.fn();
    const coordinator = new SubmissionCoordinator({
      requests: {
        find: requestsFind,
      } as unknown as Collection<RequestDocument>,
      submissions: {
        findOne: vi.fn(async () => submission),
      } as unknown as Collection<SubmissionDocument>,
      submissionRuns: {
        insertOne: archiveInsert,
      } as unknown as Collection<SubmissionRunHistoryDocument>,
      services: {} as Collection<ServiceHandlerDocument>,
    });

    const result = await coordinator.reconcile("submission-1");

    expect(result?.rolled).toBe(false);
    expect(requestsFind).not.toHaveBeenCalled();
    expect(archiveInsert).not.toHaveBeenCalled();
  });

  it("resumes an interrupted drift rollover without double-rolling a manual retry", async () => {
    const requestDocs: RequestDocument[] = [
      {
        _id: "request-1",
        projectId: "project-1",
        scenario: { task: "Task", criteria: ["criterion"] },
        workerType: "worker",
        createdAt: new Date(),
        priority: 0,
        submissionId: "submission-1",
        run: {
          _id: "run-2",
          attemptNumber: 2,
          status: "done",
          outcome: "failed",
          handlerStatus: {
            "pp-observations": { status: "done", version: 2 },
            unrelated: { status: "failed" },
          },
        },
      },
    ];
    let submission: SubmissionDocument = {
      _id: "submission-1",
      submissionId: "submission-1",
      projectId: "project-1",
      requestIds: ["request-1"],
      createdAt: new Date(),
      run: {
        _id: "submission-run-1",
        attemptNumber: 1,
        vectorFingerprint: "old-vector",
        requests: [{ requestId: "request-1", runId: "run-1" }],
        createdAt: new Date(),
        dependencyProjection: [],
        blocking: [],
      },
    };
    const history: SubmissionRunHistoryDocument[] = [];
    const services: ServiceHandlerDocument[] = [
      {
        _id: "pp-atif",
        type: "post-process-handler",
        version: 1,
        queue: "post-processor",
        selector: "atif",
        autoBackfill: true,
        dependsOn: [],
      },
      {
        _id: "pp-observations",
        type: "post-process-handler",
        version: 2,
        queue: "post-processor",
        selector: "observations",
        autoBackfill: true,
        dependsOn: ["pp-atif"],
      },
      {
        _id: "pp-readout",
        type: "submission-handler",
        version: 1,
        queue: "readout",
        selector: "readout",
        autoBackfill: false,
        dependsOn: ["pp-observations"],
        dependencyMode: "all-runs",
      },
    ];
    const submissions = {
      findOne: vi.fn(async () => structuredClone(submission)),
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
      findOneAndUpdate: vi.fn(async (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => {
        if (filter["run._id"] && filter["run._id"] !== submission.run._id) return null;
        if (update.$set["run.rollover"]) {
          submission = {
            ...submission,
            updatedAt: update.$set.updatedAt as Date,
            run: {
              ...submission.run,
              rollover: update.$set[
                "run.rollover"
              ] as SubmissionDocument["run"]["rollover"],
              updatedAt: update.$set["run.updatedAt"] as Date,
            },
          };
        } else if (update.$set.run) {
          rollAttempts++;
          if (rollAttempts === 1) return null;
          submission = {
            ...submission,
            run: update.$set.run as SubmissionDocument["run"],
            updatedAt: update.$set.updatedAt as Date,
          };
        } else {
          submission = {
            ...submission,
            updatedAt: update.$set.updatedAt as Date,
            run: {
              ...submission.run,
              dependencyProjection: update.$set[
                "run.dependencyProjection"
              ] as SubmissionDocument["run"]["dependencyProjection"],
              blocking: update.$set[
                "run.blocking"
              ] as SubmissionDocument["run"]["blocking"],
              updatedAt: update.$set["run.updatedAt"] as Date,
            },
          };
        }
        return structuredClone(submission);
      }),
    } as unknown as Collection<SubmissionDocument>;
    let rollAttempts = 0;
    const enqueue = vi.fn(async (
      _service: ServiceHandlerDocument,
      _message: { submissionId: string; submissionRunId: string; type: string },
    ) => undefined);
    const archiveUpdate = vi.fn(async (
      _filter: unknown,
      update: { $setOnInsert: SubmissionRunHistoryDocument },
    ) => {
      if (!history.some((item) => item._id === update.$setOnInsert._id)) {
        history.push(update.$setOnInsert);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    });
    const coordinator = new SubmissionCoordinator(
      {
        requests: {
          find: vi.fn(() => queryResult(requestDocs)),
        } as unknown as Collection<RequestDocument>,
        submissions,
        submissionRuns: {
          updateOne: archiveUpdate,
        } as unknown as Collection<SubmissionRunHistoryDocument>,
        services: {
          find: vi.fn(() =>
            queryResult(services.filter((service) => service.type === "post-process-handler")),
          ),
          findOne: vi.fn(async () =>
            services.find((service) => service._id === "pp-readout") ?? null,
          ),
        } as unknown as Collection<ServiceHandlerDocument>,
      },
      enqueue,
    );

    const result = await coordinator.retryCurrent(
      "submission-1",
      "submission-run-1",
    );

    expect(result?.rolled).toBe(true);
    expect(result?.submission.run.attemptNumber).toBe(2);
    expect(result?.submission.run.requests).toEqual([
      { requestId: "request-1", runId: "run-2" },
    ]);
    expect(result?.submission.run.dependencyProjection[0]).toMatchObject({
      runId: "run-2",
      state: "ready",
      version: 2,
    });
    expect(history).toHaveLength(1);
    expect(archiveUpdate).toHaveBeenCalledTimes(2);
    expect(history[0]).toMatchObject({
      _id: "submission-run-1",
      supersededBySubmissionRunId: result?.submission.run._id,
      supersededReason: "request-vector-changed",
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({
      submissionId: "submission-1",
      submissionRunId: result?.submission.run._id,
    });
  });

  it("links immutable history only to CAS-winning successors under concurrent vector drift", async () => {
    const request = (runId: string, attemptNumber: number): RequestDocument => ({
      _id: "request-1",
      projectId: "project-1",
      scenario: { task: "Task", criteria: ["criterion"] },
      workerType: "worker",
      createdAt: new Date(),
      priority: 0,
      submissionId: "submission-1",
      run: {
        _id: runId,
        attemptNumber,
        status: "done",
      },
    });
    let submission: SubmissionDocument = {
      _id: "submission-1",
      submissionId: "submission-1",
      projectId: "project-1",
      requestIds: ["request-1"],
      createdAt: new Date(),
      run: {
        _id: "submission-run-1",
        attemptNumber: 1,
        vectorFingerprint: "initial",
        requests: [{ requestId: "request-1", runId: "run-1" }],
        createdAt: new Date(),
        dependencyProjection: [],
        blocking: [],
      },
    };
    const history = new Map<string, SubmissionRunHistoryDocument>();
    const submissions = {
      findOne: vi.fn(async () => structuredClone(submission)),
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
      findOneAndUpdate: vi.fn(async (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => {
        if (filter["run._id"] !== submission.run._id) return null;
        if (update.$set["run.rollover"]) {
          if (submission.run.rollover) return null;
          submission = {
            ...submission,
            run: {
              ...submission.run,
              rollover: update.$set[
                "run.rollover"
              ] as SubmissionDocument["run"]["rollover"],
            },
          };
        } else if (update.$set.run) {
          if (
            filter["run.rollover.nextSubmissionRunId"] !==
            submission.run.rollover?.nextSubmissionRunId
          ) {
            return null;
          }
          submission = {
            ...submission,
            run: update.$set.run as SubmissionDocument["run"],
          };
        } else {
          submission = {
            ...submission,
            run: {
              ...submission.run,
              dependencyProjection: update.$set[
                "run.dependencyProjection"
              ] as SubmissionDocument["run"]["dependencyProjection"],
              blocking: update.$set[
                "run.blocking"
              ] as SubmissionDocument["run"]["blocking"],
            },
          };
        }
        return structuredClone(submission);
      }),
    } as unknown as Collection<SubmissionDocument>;
    const submissionRuns = {
      updateOne: vi.fn(async (
        filter: { _id: string },
        update: { $setOnInsert: SubmissionRunHistoryDocument },
      ) => {
        if (!history.has(filter._id)) {
          history.set(filter._id, structuredClone(update.$setOnInsert));
        }
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    } as unknown as Collection<SubmissionRunHistoryDocument>;
    const services = {
      find: vi.fn(() => queryResult([])),
      findOne: vi.fn(async () => null),
    } as unknown as Collection<ServiceHandlerDocument>;
    let firstCoordinatorReads = 0;
    const coordinatorA = new SubmissionCoordinator({
      requests: {
        find: vi.fn(() =>
          queryResult([
            firstCoordinatorReads++ === 0
              ? request("run-2", 2)
              : request("run-3", 3),
          ]),
        ),
      } as unknown as Collection<RequestDocument>,
      submissions,
      submissionRuns,
      services,
    });
    const coordinatorB = new SubmissionCoordinator({
      requests: {
        find: vi.fn(() => queryResult([request("run-3", 3)])),
      } as unknown as Collection<RequestDocument>,
      submissions,
      submissionRuns,
      services,
    });

    await Promise.all([
      coordinatorA.reconcile("submission-1"),
      coordinatorB.reconcile("submission-1"),
    ]);

    expect(submission.run.requests).toEqual([
      { requestId: "request-1", runId: "run-3" },
    ]);
    expect(submission.run.rollover).toBeUndefined();
    expect(history.size).toBe(2);
    const knownRunIds = new Set([...history.keys(), submission.run._id]);
    for (const archived of history.values()) {
      expect(knownRunIds.has(archived.supersededBySubmissionRunId!)).toBe(true);
    }
  });

  it("repairs an interrupted claimed rollover on the next polling reconciliation", async () => {
    const requestDocument: RequestDocument = {
      _id: "request-1",
      projectId: "project-1",
      scenario: { task: "Task", criteria: ["criterion"] },
      workerType: "worker",
      createdAt: new Date(),
      priority: 0,
      submissionId: "submission-1",
      run: {
        _id: "run-2",
        attemptNumber: 2,
        status: "done",
      },
    };
    let submission: SubmissionDocument = {
      _id: "submission-1",
      submissionId: "submission-1",
      projectId: "project-1",
      requestIds: ["request-1"],
      createdAt: new Date(),
      run: {
        _id: "submission-run-1",
        attemptNumber: 1,
        vectorFingerprint: "initial",
        requests: [{ requestId: "request-1", runId: "run-1" }],
        createdAt: new Date(),
        dependencyProjection: [],
        blocking: [],
      },
    };
    const history = new Map<string, SubmissionRunHistoryDocument>();
    let interruptReplacement = true;
    const submissions = {
      findOne: vi.fn(async () => structuredClone(submission)),
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
      findOneAndUpdate: vi.fn(async (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => {
        if (filter["run._id"] !== submission.run._id) return null;
        if (update.$set["run.rollover"]) {
          if (submission.run.rollover) return null;
          submission = {
            ...submission,
            run: {
              ...submission.run,
              rollover: update.$set[
                "run.rollover"
              ] as SubmissionDocument["run"]["rollover"],
            },
          };
        } else if (update.$set.run) {
          if (interruptReplacement) {
            interruptReplacement = false;
            throw new Error("simulated process interruption");
          }
          submission = {
            ...submission,
            run: update.$set.run as SubmissionDocument["run"],
          };
        } else {
          submission = {
            ...submission,
            run: {
              ...submission.run,
              dependencyProjection: update.$set[
                "run.dependencyProjection"
              ] as SubmissionDocument["run"]["dependencyProjection"],
              blocking: update.$set[
                "run.blocking"
              ] as SubmissionDocument["run"]["blocking"],
            },
          };
        }
        return structuredClone(submission);
      }),
    } as unknown as Collection<SubmissionDocument>;
    const submissionRuns = {
      updateOne: vi.fn(async (
        filter: { _id: string },
        update: { $setOnInsert: SubmissionRunHistoryDocument },
      ) => {
        if (!history.has(filter._id)) {
          history.set(filter._id, structuredClone(update.$setOnInsert));
        }
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    } as unknown as Collection<SubmissionRunHistoryDocument>;
    const collections = {
      requests: {
        find: vi.fn(() => queryResult([requestDocument])),
      } as unknown as Collection<RequestDocument>,
      submissions,
      submissionRuns,
      services: {
        find: vi.fn(() => queryResult([])),
        findOne: vi.fn(async () => null),
      } as unknown as Collection<ServiceHandlerDocument>,
    };

    await expect(
      new SubmissionCoordinator(collections).reconcile("submission-1"),
    ).rejects.toThrow("simulated process interruption");
    expect(submission.run.rollover).toBeDefined();
    expect(history.size).toBe(1);

    const repaired = await new SubmissionCoordinator(collections).reconcile(
      "submission-1",
    );

    expect(repaired?.submission.run.attemptNumber).toBe(2);
    expect(repaired?.submission.run.requests).toEqual([
      { requestId: "request-1", runId: "run-2" },
    ]);
    expect(repaired?.submission.run.rollover).toBeUndefined();
    expect(history.get("submission-run-1")?.supersededBySubmissionRunId).toBe(
      repaired?.submission.run._id,
    );
  });

  it("recovers an interrupted final submission write only for complete native request groups", async () => {
    const requests: RequestDocument[] = [
      {
        _id: "request-1",
        projectId: "project-1",
        scenario: { task: "Task", criteria: ["criterion"] },
        workerType: "worker",
        createdAt: new Date(),
        priority: 0,
        submissionId: "submission-1",
        submissionExpectedRequestCount: 2,
        submissionRequestIndex: 0,
        submissionInitialRunId: "run-1",
        run: { _id: "retried-run", attemptNumber: 2, status: "pending" },
      },
      {
        _id: "request-2",
        projectId: "project-1",
        scenario: { task: "Task", criteria: ["criterion"] },
        workerType: "worker",
        createdAt: new Date(),
        priority: 0,
        submissionId: "submission-1",
        submissionExpectedRequestCount: 2,
        submissionRequestIndex: 1,
        submissionInitialRunId: "run-2",
        run: { _id: "run-2", attemptNumber: 1, status: "pending" },
      },
    ];
    let stored: SubmissionDocument | null = null;
    const updateMany = vi.fn(async () => ({ modifiedCount: 2 }));
    const coordinator = new SubmissionCoordinator({
      requests: {
        find: vi.fn(() => queryResult(requests)),
        updateMany,
      } as unknown as Collection<RequestDocument>,
      submissions: {
        findOne: vi.fn(async () => stored),
        updateOne: vi.fn(async (
          _filter: unknown,
          update: { $setOnInsert: SubmissionDocument },
        ) => {
          stored ??= update.$setOnInsert;
          return { upsertedCount: 1 };
        }),
      } as unknown as Collection<SubmissionDocument>,
      submissionRuns: {} as Collection<SubmissionRunHistoryDocument>,
      services: {} as Collection<ServiceHandlerDocument>,
    });

    expect(await coordinator.recoverMissingNativeSubmissions()).toBe(1);
    expect(stored).not.toBeNull();
    const recovered = stored as SubmissionDocument | null;
    expect(recovered?.requestIds).toEqual(["request-1", "request-2"]);
    expect(recovered?.run.requests).toEqual([
      { requestId: "request-1", runId: "run-1" },
      { requestId: "request-2", runId: "run-2" },
    ]);
    expect(await coordinator.recoverMissingNativeSubmissions()).toBe(1);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: "submission-1",
        submissionFinalizedAt: { $exists: false },
      }),
      expect.objectContaining({ $set: { submissionFinalizedAt: expect.any(Date) } }),
    );
  });
});
