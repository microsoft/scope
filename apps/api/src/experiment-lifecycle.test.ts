// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import {
  EXPERIMENT_STORAGE_PROFILE_VERSION,
  ExperimentLifecycleTargetStore,
  ExperimentStore,
  FixedPayloadStore,
  fingerprintExperimentPayload,
  type ExperimentDocument,
  type ExperimentExecutionHistoryDocument,
  type ExperimentLifecycleTarget,
  type ExperimentRequestState,
  type ReportDocument,
  type RequestDocument,
} from "shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExperimentLifecycleCoordinator,
  type ExperimentLifecycleCollections,
} from "./experiment-lifecycle.js";

const now = new Date("2026-03-10T12:00:00.000Z");
const requestState: ExperimentRequestState = {
  requestId: "request-1",
  runId: "run-1",
  dependencies: [],
  blockers: [],
};
const requestFingerprint = fingerprintExperimentPayload([requestState]);

function root(
  lifecycle?: ExperimentDocument["lifecycle"],
): ExperimentDocument {
  return {
    _id: "experiment-1",
    experimentId: "experiment-1",
    projectId: "project-1",
    metadata: { name: "Lifecycle experiment" },
    storageProfileVersion: EXPERIMENT_STORAGE_PROFILE_VERSION,
    stateVersion: lifecycle ? 2 : 1,
    revision: {
      experimentRevisionId: "revision-1",
      revisionNumber: 1,
      memberCount: 1,
      membershipFingerprint: requestFingerprint,
      definitionFingerprint: "definition-1",
      createdAt: now,
    },
    execution: {
      experimentExecutionId: "execution-1",
      attemptNumber: 1,
      version: lifecycle ? 2 : 1,
      requests: {
        storage: "inline",
        entryCount: 1,
        payloadFingerprint: requestFingerprint,
        payloadVersion: 1,
        entries: [requestState],
      },
      vectorFingerprint: requestFingerprint,
      handlerSummary: {},
      blocking: [],
      createdAt: now,
      updatedAt: now,
      ...(lifecycle ? { frozenAt: now } : {}),
    },
    createdAt: now,
    updatedAt: now,
    finalizedAt: now,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

function lifecycle(
  phase: "deleting" | "deleted" | "restoring",
  targets: ExperimentLifecycleTarget[],
): NonNullable<ExperimentDocument["lifecycle"]> {
  const encoded = targets.map((target) => ({
    requestId: fingerprintExperimentPayload([target.kind, target.id]),
    runId: target.kind,
    dependencies: [{
      handlerId: target.id,
      state: "ready" as const,
    }],
    blockers: [],
  }));
  return {
    operationId: "operation-1",
    phase,
    stateVersion: 1,
    targets: {
      storage: "inline",
      entryCount: encoded.length,
      payloadFingerprint: fingerprintExperimentPayload(encoded),
      payloadVersion: 1,
      entries: encoded,
    },
    targetFingerprint: fingerprintExperimentPayload(targets),
    progress: {
      expectedRequests: targets.filter((target) => target.kind === "request")
        .length,
      completedRequests: 0,
      expectedReports: targets.filter((target) => target.kind === "report")
        .length,
      completedReports: 0,
    },
    blocking: [],
    deleteRequestedAt: now,
    ...(phase !== "deleting" ? { deleteCompletedAt: now } : {}),
    ...(phase === "restoring" ? { restoreRequestedAt: now } : {}),
  };
}

function cursor(documents: Document[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(documents),
  };
}

function collections(input: {
  current: ExperimentDocument;
  requests?: Document[];
  reports?: Document[];
  updated: ExperimentDocument;
}): ExperimentLifecycleCollections {
  return {
    requests: {
      find: vi.fn().mockReturnValue(cursor(input.requests ?? [])),
      updateMany: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    } as unknown as Collection<RequestDocument>,
    reports: {
      find: vi.fn().mockReturnValue(cursor(input.reports ?? [])),
      updateMany: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    } as unknown as Collection<ReportDocument>,
    experiments: {
      findOne: vi.fn().mockResolvedValue(input.current),
      findOneAndUpdate: vi.fn().mockResolvedValue(input.updated),
    } as unknown as Collection<ExperimentDocument>,
    executions: {} as Collection<ExperimentExecutionHistoryDocument>,
    chunks: {} as Collection<Document>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExperimentLifecycleCoordinator", () => {
  it("treats a completed restore as an idempotent success", async () => {
    const restored = root({
      ...lifecycle("deleted", []),
      phase: "restored",
      restoreCompletedAt: now,
    });
    const db = collections({
      current: restored,
      updated: restored,
    });

    const result = await new ExperimentLifecycleCoordinator(db).startRestore(
      "project-1",
      "experiment-1",
      now,
    );

    expect(result.lifecycle?.phase).toBe("restored");
    expect(result.lifecycle?.operationId).toBe("operation-1");
    expect(db.experiments.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("claims an asynchronous delete with only active current members and reports", async () => {
    const current = root();
    const claimed = root(
      lifecycle("deleting", [
        { kind: "request", id: "request-1" },
        { kind: "report", id: "report-1" },
      ]),
    );
    const db = collections({
      current,
      requests: [{ _id: "request-1" }],
      reports: [{ _id: "report-1" }],
      updated: claimed,
    });
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([
      requestState,
    ]);
    const prepare = vi
      .spyOn(ExperimentLifecycleTargetStore.prototype, "prepare")
      .mockImplementation(async (input) => ({
        storage: "inline",
        entryCount: input.targets.length,
        payloadFingerprint: "target-payload",
        payloadVersion: 1,
        entries: [],
      }));

    const result = await new ExperimentLifecycleCoordinator(db).startDelete(
      "project-1",
      "experiment-1",
      now,
    );

    expect(result.lifecycle?.phase).toBe("deleting");
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        experimentId: "experiment-1",
        targets: [
          { kind: "request", id: "request-1" },
          { kind: "report", id: "report-1" },
        ],
      }),
    );
    expect(db.requests.updateMany).not.toHaveBeenCalled();
    expect(db.reports.updateMany).not.toHaveBeenCalled();
    expect(db.experiments.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "experiment-1",
        projectId: "project-1",
        stateVersion: 1,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "execution.frozenAt": now,
        }),
      }),
      { returnDocument: "after" },
    );
  });

  it("repairs deletion with exact provenance and reaches deleted only after every target", async () => {
    const targets: ExperimentLifecycleTarget[] = [
      { kind: "request", id: "request-1" },
      { kind: "report", id: "report-1" },
    ];
    const current = root(lifecycle("deleting", targets));
    const deleted = {
      ...root(lifecycle("deleted", targets)),
      deletedAt: now,
    };
    const provenance = {
      kind: "experiment",
      experimentId: "experiment-1",
      operationId: "operation-1",
    };
    const db = collections({
      current,
      requests: [{
        _id: "request-1",
        deletedAt: now,
        deletionProvenance: provenance,
      }],
      reports: [{
        _id: "report-1",
        deletedAt: now,
        deletionProvenance: provenance,
      }],
      updated: deleted,
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(
      targets,
    );

    const result = await new ExperimentLifecycleCoordinator(db).repair(
      "project-1",
      "experiment-1",
    );

    expect(result.lifecycle?.phase).toBe("deleted");
    expect(db.requests.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: ["request-1"] },
        projectId: "project-1",
        experimentId: "experiment-1",
        deletedAt: { $exists: false },
      }),
      { $set: { deletedAt: expect.any(Date), deletionProvenance: provenance } },
    );
    expect(db.reports.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: ["report-1"] },
        deletedAt: { $exists: false },
      }),
      { $set: { deletedAt: expect.any(Date), deletionProvenance: provenance } },
    );
    expect(db.experiments.findOneAndUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stateVersion: current.stateVersion,
        "lifecycle.stateVersion": current.lifecycle?.stateVersion,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "lifecycle.phase": "deleted",
          deletedAt: expect.any(Date),
        }),
      }),
      { returnDocument: "after" },
    );
  });

  it("restores only exact-operation children before reviving the Experiment", async () => {
    const targets: ExperimentLifecycleTarget[] = [
      { kind: "request", id: "request-1" },
      { kind: "report", id: "report-1" },
    ];
    const current = root(lifecycle("restoring", targets));
    current.deletedAt = now;
    const restored = root({
      ...lifecycle("restoring", targets),
      phase: "restored",
      restoreCompletedAt: now,
    });
    const db = collections({
      current,
      requests: [{ _id: "request-1", run: { _id: "run-1" } }],
      reports: [{ _id: "report-1" }],
      updated: restored,
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(
      targets,
    );
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([
      requestState,
    ]);

    const result = await new ExperimentLifecycleCoordinator(db).repair(
      "project-1",
      "experiment-1",
    );

    const provenance = {
      kind: "experiment",
      experimentId: "experiment-1",
      operationId: "operation-1",
    };
    expect(db.requests.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: ["request-1"] },
        projectId: "project-1",
        deletionProvenance: provenance,
      }),
      { $unset: { deletedAt: "", deletionProvenance: "" } },
    );
    expect(db.reports.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        deletionProvenance: provenance,
      }),
      { $unset: { deletedAt: "", deletionProvenance: "" } },
    );
    expect(result.lifecycle?.phase).toBe("restored");
    expect(db.experiments.findOneAndUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stateVersion: current.stateVersion,
        "lifecycle.stateVersion": current.lifecycle?.stateVersion,
      }),
      expect.objectContaining({
        $unset: {
          deletedAt: "",
          "execution.frozenAt": "",
        },
      }),
      { returnDocument: "after" },
    );
  });

  it("converges after a delete completion CAS loses to another repair", async () => {
    const targets: ExperimentLifecycleTarget[] = [
      { kind: "request", id: "request-1" },
    ];
    const deleting = root(lifecycle("deleting", targets));
    const deleted = {
      ...root(lifecycle("deleted", targets)),
      deletedAt: now,
    };
    const provenance = {
      kind: "experiment",
      experimentId: "experiment-1",
      operationId: "operation-1",
    };
    const db = collections({
      current: deleting,
      requests: [{
        _id: "request-1",
        deletedAt: now,
        deletionProvenance: provenance,
      }],
      updated: deleted,
    });
    vi.mocked(db.experiments.findOne)
      .mockResolvedValueOnce(deleting)
      .mockResolvedValueOnce(deleted);
    vi.mocked(db.experiments.findOneAndUpdate).mockResolvedValueOnce(null);
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(
      targets,
    );

    const result = await new ExperimentLifecycleCoordinator(db).repair(
      "project-1",
      "experiment-1",
    );

    expect(result.lifecycle?.phase).toBe("deleted");
    expect(db.experiments.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(db.experiments.findOne).toHaveBeenCalledTimes(2);
  });

  it("keeps a missing target as a repairable blocker", async () => {
    const targets: ExperimentLifecycleTarget[] = [
      { kind: "request", id: "missing-request" },
    ];
    const deleting = root(lifecycle("deleting", targets));
    const blocked = root({
      ...lifecycle("deleting", targets),
      stateVersion: 2,
      blocking: [{
        kind: "request",
        id: "missing-request",
        reason: "target-missing",
      }],
    });
    const db = collections({
      current: deleting,
      requests: [],
      updated: blocked,
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(
      targets,
    );

    const result = await new ExperimentLifecycleCoordinator(db).repair(
      "project-1",
      "experiment-1",
    );

    expect(result.lifecycle?.phase).toBe("deleting");
    expect(result.lifecycle?.blocking).toEqual([{
      kind: "request",
      id: "missing-request",
      reason: "target-missing",
    }]);
    expect(db.experiments.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        stateVersion: deleting.stateVersion,
        "lifecycle.stateVersion": deleting.lifecycle?.stateVersion,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "lifecycle.progress.completedRequests": 0,
          "lifecycle.blocking": [{
            kind: "request",
            id: "missing-request",
            reason: "target-missing",
          }],
        }),
      }),
      { returnDocument: "after" },
    );
  });

  it("does not restore an independently deleted record outside the operation snapshot", async () => {
    const targets: ExperimentLifecycleTarget[] = [
      { kind: "request", id: "request-1" },
    ];
    const restoring = root(lifecycle("restoring", targets));
    restoring.deletedAt = now;
    const restored = root({
      ...lifecycle("restoring", targets),
      phase: "restored",
      restoreCompletedAt: now,
    });
    const db = collections({
      current: restoring,
      requests: [
        { _id: "request-1", run: { _id: "run-1" } },
        {
          _id: "request-independent",
          deletedAt: now,
          deletionProvenance: { kind: "user" },
          run: { _id: "run-independent" },
        },
      ],
      updated: restored,
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(
      targets,
    );
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([
      requestState,
    ]);

    await new ExperimentLifecycleCoordinator(db).repair(
      "project-1",
      "experiment-1",
    );

    expect(db.requests.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: ["request-1"] },
        deletionProvenance: {
          kind: "experiment",
          experimentId: "experiment-1",
          operationId: "operation-1",
        },
      }),
      { $unset: { deletedAt: "", deletionProvenance: "" } },
    );
    expect(
      vi.mocked(db.requests.updateMany).mock.calls.some(([filter]) =>
        JSON.stringify(filter).includes("request-independent"),
      ),
    ).toBe(false);
  });

  it("completes an empty delete without child writes", async () => {
    const deleting = root(lifecycle("deleting", []));
    const deleted = {
      ...root(lifecycle("deleted", [])),
      deletedAt: now,
    };
    const db = collections({
      current: deleting,
      updated: deleted,
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(
      [],
    );

    const result = await new ExperimentLifecycleCoordinator(db).repair(
      "project-1",
      "experiment-1",
    );

    expect(result.lifecycle?.phase).toBe("deleted");
    expect(db.requests.updateMany).not.toHaveBeenCalled();
    expect(db.reports.updateMany).not.toHaveBeenCalled();
    expect(db.experiments.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          "lifecycle.phase": "deleted",
          "lifecycle.progress.completedRequests": 0,
          "lifecycle.progress.completedReports": 0,
        }),
      }),
      { returnDocument: "after" },
    );
  });

  it("rolls to a fresh execution before restore when the exact request vector drifted", async () => {
    const targets: ExperimentLifecycleTarget[] = [
      { kind: "request", id: "request-1" },
    ];
    const restoring = root(lifecycle("restoring", targets));
    restoring.deletedAt = now;
    const nextRequest = { ...requestState, runId: "run-2" };
    const rolled = root(lifecycle("restoring", targets));
    rolled.stateVersion = 3;
    rolled.execution = {
      ...rolled.execution,
      experimentExecutionId: "execution-2",
      attemptNumber: 2,
      version: 3,
      requests: {
        storage: "inline",
        entryCount: 1,
        payloadFingerprint: fingerprintExperimentPayload([nextRequest]),
        payloadVersion: 1,
        entries: [nextRequest],
      },
      vectorFingerprint: fingerprintExperimentPayload([nextRequest]),
    };
    const restored = {
      ...rolled,
      lifecycle: {
        ...rolled.lifecycle!,
        phase: "restored" as const,
        restoreCompletedAt: now,
      },
    };
    const db = collections({
      current: restoring,
      requests: [{ _id: "request-1", run: { _id: "run-2" } }],
      updated: restored,
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(
      targets,
    );
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([
      requestState,
    ]);
    const rollover = vi
      .spyOn(ExperimentStore.prototype, "rollover")
      .mockResolvedValue(rolled);

    const result = await new ExperimentLifecycleCoordinator(db).repair(
      "project-1",
      "experiment-1",
    );

    expect(rollover).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        experimentId: "experiment-1",
        expectedExperimentExecutionId: "execution-1",
        expectedExecutionVersion: restoring.execution.version,
        nextExperimentExecutionId: expect.any(String),
        requests: [nextRequest],
        reason: "rollover",
      }),
    );
    expect(
      vi.mocked(rollover).mock.calls[0]?.[0].nextExperimentExecutionId,
    ).not.toBe("execution-1");
    expect(result.execution.experimentExecutionId).toBe("execution-2");
    expect(result.lifecycle?.phase).toBe("restored");
  });
});
