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
      handlerSummary: { "pp-readout": { status: "done", version: 1, updatedAt: now } },
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
    toArray: vi.fn().mockImplementation(async () => structuredClone(documents)),
  };
}

function collections(input: {
  current: ExperimentDocument;
  requests?: Document[];
  reports?: Document[];
  updated: ExperimentDocument;
}): ExperimentLifecycleCollections {
  // Model only the child filters and tombstones used by lifecycle operations,
  // so retries observe their previous writes rather than canned query results.
  const childCollection = (documents: Document[]) => {
    const matches = (document: Document, filter: Document): boolean =>
      Object.entries(filter).every(([key, value]) => {
        if (key === "$or") return (value as Document[]).some(clause => matches(document, clause));
        const actual: unknown = key.split(".").reduce<unknown>((item, part) =>
          item && typeof item === "object" ? (item as Document)[part] : undefined, document);
        if (value && typeof value === "object" && !(value instanceof Date)) {
          if ("$exists" in value) return (actual !== undefined) === value.$exists;
          if ("$in" in value) return value.$in.includes(actual);
          if ("$nin" in value) return !value.$nin.includes(actual);
        }
        return JSON.stringify(actual) === JSON.stringify(value);
      });
    return {
      find: vi.fn((filter: Document) => cursor(documents.filter(document => matches(document, filter)))),
      updateMany: vi.fn(async (filter: Document, update: Document) => {
        const selected = documents.filter(document => matches(document, filter));
        for (const document of selected) {
          Object.assign(document, update.$set);
          for (const key of Object.keys(update.$unset ?? {})) delete document[key];
        }
        return { matchedCount: selected.length, modifiedCount: selected.length };
      }),
    };
  };
  const requests = (input.requests ?? []).map(document => ({
    projectId: "project-1",
    experimentId: "experiment-1",
    ...document,
    run: { _id: "run-1", status: "done", attemptNumber: 1, reportsTriggerCompletedAt: now, ...document.run },
  }));
  const reports = (input.reports ?? []).map(document => ({
    projectId: "project-1", experimentId: "experiment-1", status: "completed", ...document,
  }));
  return {
    requests: childCollection(requests) as unknown as Collection<RequestDocument>,
    reports: childCollection(reports) as unknown as Collection<ReportDocument>,
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
  it.each(["pending", "queued", "processing", "paused"])("rejects a %s member even when aggregate readiness is failed", async (status) => {
    const current = root();
    current.execution.handlerSummary["pp-readout"]!.status = "failed";
    const db = collections({ current, updated: current, requests: [{ _id: "request-1", run: { _id: "run-1", status } }] });
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([requestState]);
    await expect(new ExperimentLifecycleCoordinator(db).startDelete("project-1", "experiment-1")).rejects.toMatchObject({
      status: 409,
      conflicts: expect.arrayContaining([expect.objectContaining({ requestId: "request-1", runId: "run-1", reason: `coding-${status}` })]),
    });
    expect(db.experiments.findOneAndUpdate).not.toHaveBeenCalled();
    expect(db.requests.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { status: "done", handlerStatus: { "pp-atif": { status: "queued" } } },
    { status: "done", reportsTriggerCompletedAt: undefined },
    { status: "done", reportPublicationIds: ["publishing-report"] },
  ])("rejects unfinished run work $handlerStatus $reportPublicationIds", async (run) => {
    const current = root();
    const db = collections({ current, updated: current, requests: [{ _id: "request-1", run }] });
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([requestState]);
    await expect(new ExperimentLifecycleCoordinator(db).startDelete("project-1", "experiment-1")).rejects.toMatchObject({ status: 409 });
    expect(db.experiments.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each(["pending", "generating"])("rejects an outstanding %s report by exact report ID", async (status) => {
    const current = root();
    const db = collections({ current, updated: current, requests: [{ _id: "request-1" }], reports: [{ _id: "report-busy", status }] });
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([requestState]);
    await expect(new ExperimentLifecycleCoordinator(db).startDelete("project-1", "experiment-1")).rejects.toMatchObject({
      conflicts: expect.arrayContaining([expect.objectContaining({ reportId: "report-busy" })]),
    });
    expect(db.experiments.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects active Experiment handlers even when another handler failed", async () => {
    const current = root();
    current.execution.handlerSummary = {
      failed: { status: "failed", version: 1, updatedAt: now },
      busy: { status: "processing", version: 1, updatedAt: now },
    };
    const db = collections({ current, updated: current, requests: [{ _id: "request-1" }] });
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([requestState]);
    await expect(new ExperimentLifecycleCoordinator(db).startDelete("project-1", "experiment-1")).rejects.toMatchObject({
      conflicts: expect.arrayContaining([expect.objectContaining({ handlerId: "busy" })]),
    });
  });

  it("fences the delete claim against a concurrent execution writer", async () => {
    const current = root();
    const db = collections({ current, updated: current, requests: [{ _id: "request-1" }] });
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([requestState]);
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "prepare").mockResolvedValue(lifecycle("deleting", []).targets);
    const discard = vi.spyOn(ExperimentLifecycleTargetStore.prototype, "discard").mockResolvedValue();
    vi.mocked(db.experiments.findOneAndUpdate).mockResolvedValue(null);
    await expect(new ExperimentLifecycleCoordinator(db).startDelete("project-1", "experiment-1")).rejects.toMatchObject({ status: 409 });
    expect(db.experiments.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ "execution.experimentExecutionId": "execution-1", "execution.version": 1, "execution.rollover": { $exists: false }, "execution.requestStateUpdate": { $exists: false } }),
      expect.anything(), expect.anything(),
    );
    expect(discard).toHaveBeenCalledOnce();
    expect(db.requests.updateMany).not.toHaveBeenCalled();
  });

  it("returns pending for a large restore without synchronously cascading", async () => {
    const targets = Array.from({ length: 501 }, (_, index) => ({ kind: "request" as const, id: `request-${index}` }));
    const deleted = { ...root(lifecycle("deleted", targets)), deletedAt: now };
    const restoring = { ...root(lifecycle("restoring", targets)), deletedAt: now };
    const db = collections({ current: deleted, updated: restoring });
    const result = await new ExperimentLifecycleCoordinator(db).startRestore("project-1", "experiment-1");
    expect(result.lifecycle?.phase).toBe("restoring");
    expect(db.requests.find).not.toHaveBeenCalled();
    expect(db.requests.updateMany).not.toHaveBeenCalled();
  });

  it("converges when concurrent restore completion removed lifecycle bookkeeping", async () => {
    const restoring = { ...root(lifecycle("restoring", [])), deletedAt: now };
    const active = root();
    active.execution.requests = { storage: "inline", entryCount: 0, entries: [], payloadVersion: 1, payloadFingerprint: fingerprintExperimentPayload([]) };
    const db = collections({ current: restoring, updated: active });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue([]);
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([]);
    vi.mocked(db.experiments.findOne).mockResolvedValueOnce(restoring).mockResolvedValueOnce(active);
    vi.mocked(db.experiments.findOneAndUpdate).mockResolvedValue(null);
    const result = await new ExperimentLifecycleCoordinator(db).repair("project-1", "experiment-1");
    expect(result.lifecycle).toBeUndefined();
    expect(result.deletedAt).toBeUndefined();
    expect(result.execution.experimentExecutionId).toBe("execution-1");
  });

  it("does not re-tombstone restored children from a delayed delete repair", async () => {
    const targets: ExperimentLifecycleTarget[] = [
      { kind: "request", id: "request-1" }, { kind: "report", id: "report-1" },
    ];
    const deleting = root(lifecycle("deleting", targets));
    const active = root();
    const db = collections({
      current: deleting, updated: active,
      requests: [{ _id: "request-1", lastDeletionOperationId: "operation-1" }],
      reports: [{ _id: "report-1", lastDeletionOperationId: "operation-1" }],
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(targets);
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([requestState]);
    // Even an old root read cannot reapply this operation to already restored
    // children. Its completion CAS then observes the conflicting active root.
    vi.mocked(db.experiments.findOne).mockResolvedValueOnce(deleting).mockResolvedValueOnce(deleting).mockResolvedValue(active);
    vi.mocked(db.experiments.findOneAndUpdate).mockResolvedValue(null);
    await expect(new ExperimentLifecycleCoordinator(db).repair("project-1", "experiment-1")).rejects.toMatchObject({ status: 409 });
    expect(db.requests.updateMany).not.toHaveBeenCalled();
    expect(db.reports.updateMany).not.toHaveBeenCalled();
  });

  it("treats a completed restore as an idempotent success", async () => {
    const restored = root();
    const db = collections({
      current: restored,
      updated: restored,
    });

    const result = await new ExperimentLifecycleCoordinator(db).startRestore(
      "project-1",
      "experiment-1",
      now,
    );

    expect(result.lifecycle).toBeUndefined();
    expect(result.execution.experimentExecutionId).toBe("execution-1");
    expect(db.experiments.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "failed", "finished"])("preserves %s run results and exact attempts through delete, restore and a later delete", async (outcome) => {
    const targets: ExperimentLifecycleTarget[] = [{ kind: "request", id: "request-1" }];
    const deleting = root(lifecycle("deleting", targets));
    const deleted = { ...root(lifecycle("deleted", targets)), deletedAt: now };
    const restoring = { ...root(lifecycle("restoring", targets)), deletedAt: now };
    const active = root();
    const db = collections({
      current: deleting, updated: deleted,
      requests: [{ _id: "request-1", run: { _id: "run-1", outcome, result: "retained result", turns: [{ iteration: 1 }] } }],
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(targets);
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([requestState]);
    const rollover = vi.spyOn(ExperimentStore.prototype, "rollover");
    const coordinator = new ExperimentLifecycleCoordinator(db);
    const before = (await db.requests.find({ _id: "request-1" }).toArray())[0]!.run;
    await coordinator.repair("project-1", "experiment-1");

    // Restore only the operation-owned visibility fields, not processing data.
    vi.mocked(db.experiments.findOne).mockResolvedValue(restoring);
    vi.mocked(db.experiments.findOneAndUpdate).mockResolvedValue(active);
    const restored = await coordinator.repair("project-1", "experiment-1");
    const after = (await db.requests.find({ _id: "request-1" }).toArray())[0]!;
    expect(after.run).toEqual(before);
    expect(after.deletedAt).toBeUndefined();
    expect(after.deletionProvenance).toBeUndefined();
    expect(restored.lifecycle).toBeUndefined();
    expect(restored.execution.experimentExecutionId).toBe("execution-1");
    expect(rollover).not.toHaveBeenCalled();

    // Successful completion removes the intent, so a new deletion can claim it.
    vi.mocked(db.experiments.findOne).mockResolvedValue(active);
    vi.mocked(db.experiments.findOneAndUpdate).mockResolvedValue(deleting);
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "prepare").mockResolvedValue(lifecycle("deleting", targets).targets);
    expect((await coordinator.startDelete("project-1", "experiment-1")).lifecycle?.phase).toBe("deleting");
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
      }],
      reports: [{
        _id: "report-1",
      }],
      updated: deleted,
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(
      targets,
    );
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([requestState]);

    const result = await new ExperimentLifecycleCoordinator(db).repair(
      "project-1",
      "experiment-1",
    );

    expect(result.lifecycle?.phase).toBe("deleted");
    expect(db.requests.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [expect.objectContaining({ _id: "request-1", projectId: "project-1", "run._id": "run-1", "run.status": "done" })],
        experimentId: "experiment-1",
      }),
      { $set: { deletedAt: expect.any(Date), deletionProvenance: provenance, lastDeletionOperationId: "operation-1" } },
    );
    expect(db.reports.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [{ _id: "report-1", lastDeletionOperationId: { $exists: false } }],
        deletedAt: { $exists: false },
      }),
      { $set: { deletedAt: expect.any(Date), deletionProvenance: provenance, lastDeletionOperationId: "operation-1" } },
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
    const restored = root();
    const provenance = { kind: "experiment", experimentId: "experiment-1", operationId: "operation-1" };
    const db = collections({
      current,
      requests: [{ _id: "request-1", run: { _id: "run-1" }, deletedAt: now, deletionProvenance: provenance }],
      reports: [{ _id: "report-1", deletedAt: now, deletionProvenance: provenance }],
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
    expect(result.lifecycle).toBeUndefined();
    expect(db.experiments.findOneAndUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stateVersion: current.stateVersion,
        "lifecycle.stateVersion": current.lifecycle?.stateVersion,
      }),
      expect.objectContaining({
        $unset: {
          deletedAt: "",
          lifecycle: "",
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
    expect(db.experiments.findOne).toHaveBeenCalledTimes(3);
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
    const restored = root();
    const db = collections({
      current: restoring,
      requests: [
        { _id: "request-1", run: { _id: "run-1" }, deletedAt: now, deletionProvenance: { kind: "experiment", experimentId: "experiment-1", operationId: "operation-1" } },
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

  it("blocks vector drift without creating a fresh execution", async () => {
    const targets: ExperimentLifecycleTarget[] = [
      { kind: "request", id: "request-1" },
    ];
    const restoring = root(lifecycle("restoring", targets));
    restoring.deletedAt = now;
    const blocked = {
      ...restoring,
      lifecycle: {
        ...restoring.lifecycle!,
        blocking: [{ kind: "experiment" as const, id: "experiment-1", reason: "reconciliation-failed" as const }],
      },
    };
    const db = collections({
      current: restoring,
      requests: [{ _id: "request-1", run: { _id: "run-2" } }],
      updated: blocked,
    });
    vi.spyOn(ExperimentLifecycleTargetStore.prototype, "read").mockResolvedValue(
      targets,
    );
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([
      requestState,
    ]);
    const rollover = vi
      .spyOn(ExperimentStore.prototype, "rollover")
      .mockResolvedValue(null);

    const result = await new ExperimentLifecycleCoordinator(db).repair(
      "project-1",
      "experiment-1",
    );

    expect(rollover).not.toHaveBeenCalled();
    expect(result.execution).toEqual(restoring.execution);
    expect(result.lifecycle?.phase).toBe("restoring");
    expect(db.experiments.findOneAndUpdate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      $set: expect.objectContaining({ "lifecycle.blocking": [expect.objectContaining({ reason: "reconciliation-failed" })] }),
    }), expect.anything());
  });
});
