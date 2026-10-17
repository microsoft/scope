// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import { describe, expect, it } from "vitest";
import { ExperimentStore } from "./experiment-store.js";
import { FixedPayloadStore } from "./fixed-payload-store.js";
import {
  fingerprintExperimentPayload,
  fingerprintExperimentRequestVector,
} from "./routing.js";
import {
  EXPERIMENT_STORAGE_PROFILE_VERSION,
  type ExperimentDocument,
  type ExperimentExecutionHistoryDocument,
  type ExperimentRequestState,
} from "./types.js";

function getPath(source: object, path: string): unknown {
  let value: unknown = source;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function setPath(target: object, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== "object" || next === null) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function unsetPath(target: object, path: string): void {
  const segments = path.split(".");
  let current = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== "object" || next === null) return;
    current = next as Record<string, unknown>;
  }
  delete current[segments.at(-1)!];
}

function matches(document: object, filter: Document): boolean {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = getPath(document, path);
    if (
      typeof expected === "object" &&
      expected !== null &&
      "$exists" in expected
    ) {
      return (
        (actual !== undefined) ===
        Boolean((expected as { $exists: unknown }).$exists)
      );
    }
    return actual === expected;
  });
}

function atomicCollection(initial: ExperimentDocument) {
  let document = structuredClone(initial);
  let findOneAndUpdateCalls = 0;
  let failAtCall: number | undefined;
  return {
    current: () => structuredClone(document),
    failOnFindOneAndUpdate(call: number) {
      failAtCall = call;
    },
    async findOne(filter: Document) {
      return matches(document, filter) ? structuredClone(document) : null;
    },
    async findOneAndUpdate(
      filter: Document,
      update: {
        $set?: Record<string, unknown>;
        $inc?: Record<string, number>;
        $unset?: Record<string, unknown>;
      },
    ) {
      findOneAndUpdateCalls += 1;
      if (findOneAndUpdateCalls === failAtCall) {
        throw new Error("injected root publication failure");
      }
      if (!matches(document, filter)) return null;
      const next = structuredClone(document);
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        setPath(next, path, value);
      }
      for (const [path, increment] of Object.entries(update.$inc ?? {})) {
        const value = getPath(next, path);
        if (typeof value !== "number") throw new Error(`Non-number ${path}`);
        setPath(next, path, value + increment);
      }
      for (const path of Object.keys(update.$unset ?? {})) {
        unsetPath(next, path);
      }
      document = next;
      return structuredClone(document);
    },
    async updateOne(
      filter: Document,
      update: {
        $set?: Record<string, unknown>;
        $inc?: Record<string, number>;
        $unset?: Record<string, unknown>;
      },
    ) {
      const updated = await this.findOneAndUpdate(filter, update);
      return {
        matchedCount: updated ? 1 : 0,
        modifiedCount: updated ? 1 : 0,
      };
    },
  };
}

function experiment(): ExperimentDocument {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const entries = [
    {
      requestId: "request-1",
      runId: "run-1",
      dependencies: [],
      blockers: [],
    },
  ];
  return {
    _id: "experiment-1",
    experimentId: "experiment-1",
    projectId: "project-1",
    metadata: { name: "Experiment" },
    storageProfileVersion: EXPERIMENT_STORAGE_PROFILE_VERSION,
    stateVersion: 2,
    revision: {
      experimentRevisionId: "revision-1",
      revisionNumber: 1,
      memberCount: 1,
      membershipFingerprint: "membership",
      reportTemplateIds: [],
      definitionFingerprint: "definition",
      createdAt: now,
    },
    execution: {
      experimentExecutionId: "execution-1",
      attemptNumber: 1,
      version: 1,
      requests: {
        storage: "inline",
        entryCount: 1,
        payloadFingerprint: fingerprintExperimentPayload(entries),
        payloadVersion: 1,
        entries,
      },
      vectorFingerprint: fingerprintExperimentRequestVector(entries),
      handlerSummary: {
        report: {
          status: "queued",
          version: 1,
          claimToken: "claim-1",
          updatedAt: now,
        },
      },
      reportTemplates: {},
      blocking: [],
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    finalizedAt: now,
  };
}

function chunkCollection() {
  const documents = new Map<string, Document>();
  return {
    documents,
    async updateOne(
      filter: Document,
      update: { $setOnInsert?: Document; $set?: Document },
    ) {
      const id = String(filter._id);
      const existing = documents.get(id);
      if (!existing && update.$setOnInsert) {
        documents.set(id, structuredClone(update.$setOnInsert));
        return { matchedCount: 1, modifiedCount: 1 };
      }
      if (!existing) return { matchedCount: 0, modifiedCount: 0 };
      const matches = Object.entries(filter).every(([key, expected]) => {
        const actual = existing[key];
        if (
          typeof expected === "object" &&
          expected !== null &&
          "$exists" in expected
        ) {
          return (
            (actual !== undefined) ===
            Boolean((expected as { $exists: unknown }).$exists)
          );
        }
        return actual === expected;
      });
      if (!matches) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(existing, structuredClone(update.$set));
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOne(filter: Document) {
      return documents.get(String(filter._id)) ?? null;
    },
    async deleteMany(filter: { _id: { $in: string[] } }) {
      let deletedCount = 0;
      for (const id of filter._id.$in) {
        if (documents.delete(id)) deletedCount += 1;
      }
      return { deletedCount };
    },
  };
}

function historyCollection() {
  const documents = new Map<string, Document>();
  return {
    documents,
    async updateOne(
      filter: Document,
      update: { $setOnInsert?: Document },
    ) {
      const id = String(filter._id);
      if (!documents.has(id) && update.$setOnInsert) {
        documents.set(id, structuredClone(update.$setOnInsert));
      }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
    async findOne(filter: Document) {
      return structuredClone(documents.get(String(filter._id)) ?? null);
    },
  };
}

function requestVector(count: number): ExperimentRequestState[] {
  return Array.from({ length: count }, (_, index) => ({
    requestId: `request-${index.toString().padStart(5, "0")}`,
    runId: `run-${index.toString().padStart(5, "0")}`,
    dependencies: [
      {
        handlerId: "pp-observations",
        state: index % 2 === 0 ? "ready" as const : "waiting" as const,
        ...(index % 2 === 0 ? { version: 3 } : {}),
      },
    ],
    blockers:
      index % 2 === 0
        ? []
        : [{
            requestId: `request-${index.toString().padStart(5, "0")}`,
            runId: `run-${index.toString().padStart(5, "0")}`,
            handlerId: "pp-observations",
            reason: "dependency-not-ready" as const,
          }],
  }));
}

describe("ExperimentStore CAS contracts", () => {
  it("treats duplicate and order-only report-template selections as a no-op", async () => {
    const root = experiment();
    root.revision.reportTemplateIds = ["alpha", "beta"];
    const experiments = atomicCollection(root);
    const store = new ExperimentStore({
      experiments: experiments as unknown as Collection<ExperimentDocument>,
      executions:
        historyCollection() as unknown as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunkCollection() as unknown as Collection,
    });

    const result = await store.replaceReportTemplates({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      expectedRevisionNumber: 1,
      expectedExperimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      nextExperimentRevisionId: "revision-2",
      nextExperimentExecutionId: "execution-2",
      reportTemplateIds: ["beta", "alpha", "beta"],
    });

    expect(result?.revision.experimentRevisionId).toBe("revision-1");
    expect(result?.execution.experimentExecutionId).toBe("execution-1");
    expect(experiments.current().stateVersion).toBe(2);
  });

  it("publishes a template-only revision and reuses only exact immutable report identities", async () => {
    const root = experiment();
    root.execution.handlerSummary["pp-readout"] = {
      status: "done",
      version: 1,
      updatedAt: root.updatedAt,
    };
    root.execution.report = {
      reportId: "readout-1",
      url: "/reports/readout-1",
      updatedAt: root.updatedAt,
    };
    root.execution.reportTemplates = {
      unchanged: {
        templateId: "unchanged",
        templateVersionId: "unchanged:v2",
        templateVersion: 2,
        templateContentFingerprint: "fingerprint-2",
        source: "selected",
        status: "done",
        matchingRunCount: 0,
        blockers: [],
        report: {
          reportId: "report-unchanged",
          url: "/reports/report-unchanged",
          updatedAt: root.updatedAt,
        },
        updatedAt: root.updatedAt,
      },
      changed: {
        templateId: "changed",
        templateVersionId: "changed:v1",
        templateVersion: 1,
        templateContentFingerprint: "fingerprint-1",
        source: "selected",
        status: "done",
        matchingRunCount: 0,
        blockers: [],
        report: {
          reportId: "report-changed",
          url: "/reports/report-changed",
          updatedAt: root.updatedAt,
        },
        updatedAt: root.updatedAt,
      },
    };
    const experiments = atomicCollection(root);
    const store = new ExperimentStore({
      experiments: experiments as unknown as Collection<ExperimentDocument>,
      executions:
        historyCollection() as unknown as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunkCollection() as unknown as Collection,
    });

    const result = await store.replaceReportTemplates({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      expectedRevisionNumber: 1,
      expectedExperimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      nextExperimentRevisionId: "revision-2",
      nextExperimentExecutionId: "execution-2",
      reportTemplateIds: ["changed", "unchanged"],
      reusableTemplateVersionIds: {
        unchanged: "unchanged:v2",
        changed: "changed:v2",
      },
    });

    expect(result).toMatchObject({
      revision: {
        experimentRevisionId: "revision-2",
        revisionNumber: 2,
        reportTemplateIds: ["changed", "unchanged"],
      },
      execution: {
        experimentExecutionId: "execution-2",
        attemptNumber: 1,
        handlerSummary: {
          "pp-readout": { status: "done" },
        },
        reportTemplates: {
          unchanged: {
            templateVersionId: "unchanged:v2",
            status: "done",
          },
        },
      },
    });
    expect(result?.execution.reportTemplates.changed).toBeUndefined();
  });

  it("rejects stale report-template claims and completion tokens", async () => {
    const root = experiment();
    root.execution.reportTemplates = {
      summary: {
        templateId: "summary",
        templateVersionId: "summary:v1",
        templateVersion: 1,
        templateContentFingerprint: "fingerprint",
        source: "selected",
        status: "queued",
        claimToken: "claim-1",
        matchingRunCount: 0,
        blockers: [],
        updatedAt: root.updatedAt,
      },
    };
    const experiments = atomicCollection(root);
    const store = new ExperimentStore({
      experiments: experiments as unknown as Collection<ExperimentDocument>,
      executions: {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: {} as Collection,
    });

    await expect(
      store.claimReportTemplate({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
        templateId: "summary",
        templateVersionId: "summary:v2",
        claimToken: "claim-1",
      }),
    ).resolves.toBeNull();

    const claimed = await store.claimReportTemplate({
      projectId: "project-1",
      experimentId: "experiment-1",
      experimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      templateId: "summary",
      templateVersionId: "summary:v1",
      claimToken: "claim-1",
    });
    expect(claimed?.execution.version).toBe(2);

    await expect(
      store.completeReportTemplate({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 2,
        templateId: "summary",
        templateVersionId: "summary:v1",
        claimToken: "stale",
        status: "done",
      }),
    ).resolves.toBeNull();

    const completed = await store.completeReportTemplate({
      projectId: "project-1",
      experimentId: "experiment-1",
      experimentExecutionId: "execution-1",
      expectedExecutionVersion: 2,
      templateId: "summary",
      templateVersionId: "summary:v1",
      claimToken: "claim-1",
      status: "done",
      report: {
        reportId: "report-1",
        url: "/reports/report-1",
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
      },
    });
    expect(completed?.execution.reportTemplates.summary).toMatchObject({
      status: "done",
      report: { reportId: "report-1" },
    });
  });

  it("publishes inline membership revisions without changing representation", async () => {
    const experiments = atomicCollection(experiment());
    const histories = historyCollection();
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        histories as unknown as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunkCollection() as unknown as Collection,
    });
    const nextRequests = requestVector(2);

    const claimed = await store.replaceMembership({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      expectedRevisionNumber: 1,
      expectedExperimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      nextExperimentRevisionId: "revision-2",
      nextExperimentExecutionId: "execution-2",
      requests: nextRequests,
      deferPublication: true,
    });

    expect(claimed?.execution.requests.storage).toBe("inline");
    expect(
      claimed?.execution.rollover?.nextExecution.requests.storage,
    ).toBe("inline");
    const published = await store.repairRollover(
      "project-1",
      "experiment-1",
    );
    expect(published).toMatchObject({
      revision: {
        experimentRevisionId: "revision-2",
        revisionNumber: 2,
        memberCount: 2,
      },
      execution: {
        experimentExecutionId: "execution-2",
        attemptNumber: 1,
        requests: {
          storage: "inline",
          entryCount: 2,
        },
      },
    });
    expect(
      await store.readExecutionRequests({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-2",
      }),
    ).toEqual(nextRequests);
  });

  it("archives an immutable inline revision while publishing chunked membership", async () => {
    const experiments = atomicCollection(experiment());
    const chunks = chunkCollection();
    const histories = historyCollection();
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        histories as unknown as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunks as unknown as Collection,
    });
    const nextRequests = requestVector(4_000);

    const claimed = await store.replaceMembership({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      expectedRevisionNumber: 1,
      expectedExperimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      nextExperimentRevisionId: "revision-2",
      nextExperimentExecutionId: "execution-2",
      requests: nextRequests,
      deferPublication: true,
    });

    expect(
      claimed?.execution.rollover?.nextExecution.requests.storage,
    ).toBe("chunked");
    const published = await store.repairRollover(
      "project-1",
      "experiment-1",
    );
    expect(published?.execution.requests.storage).toBe("chunked");
    expect(published?.revision.membershipFingerprint).toBe(
      fingerprintExperimentRequestVector(nextRequests),
    );
    expect(
      await store.readExecutionRequests({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-2",
      }),
    ).toEqual(nextRequests);
    expect(histories.documents.get("execution-1")).toMatchObject({
      revision: { experimentRevisionId: "revision-1" },
      requests: { storage: "inline", entryCount: 1 },
    });
  });

  it("plans chunked-to-chunked growth and chunked-to-inline shrink independently", async () => {
    const chunks = chunkCollection();
    const payloadStore = new FixedPayloadStore(
      chunks as unknown as Collection<Document>,
    );
    const currentRequests = requestVector(4_000);
    const root = experiment();
    root.revision.memberCount = currentRequests.length;
    root.revision.membershipFingerprint =
      fingerprintExperimentRequestVector(currentRequests);
    root.execution.requests = await payloadStore.prepareRequests({
      identity: {
        projectId: "project-1",
        experimentId: "experiment-1",
        ownerId: "execution-1",
        generation: 1,
      },
      entries: currentRequests,
      inlineDocument: (requests) => ({
        ...root,
        execution: { ...root.execution, requests },
      }),
    });
    root.execution.vectorFingerprint =
      fingerprintExperimentRequestVector(currentRequests);
    expect(root.execution.requests.storage).toBe("chunked");

    const growExperiments = atomicCollection(root);
    const grow = new ExperimentStore({
      experiments:
        growExperiments as unknown as Collection<ExperimentDocument>,
      executions:
        historyCollection() as unknown as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunks as unknown as Collection,
    });
    const grownRequests = requestVector(4_200);
    const grown = await grow.replaceMembership({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      expectedRevisionNumber: 1,
      expectedExperimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      nextExperimentRevisionId: "revision-grown",
      nextExperimentExecutionId: "execution-grown",
      requests: grownRequests,
      deferPublication: true,
    });
    expect(
      grown?.execution.rollover?.nextExecution.requests.storage,
    ).toBe("chunked");

    const shrinkExperiments = atomicCollection(root);
    const shrink = new ExperimentStore({
      experiments:
        shrinkExperiments as unknown as Collection<ExperimentDocument>,
      executions:
        historyCollection() as unknown as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunks as unknown as Collection,
    });
    const shrunkRequests = requestVector(1);
    const shrunk = await shrink.replaceMembership({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      expectedRevisionNumber: 1,
      expectedExperimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      nextExperimentRevisionId: "revision-shrunk",
      nextExperimentExecutionId: "execution-shrunk",
      requests: shrunkRequests,
      deferPublication: true,
    });
    expect(
      shrunk?.execution.rollover?.nextExecution.requests.storage,
    ).toBe("inline");
  });

  it("atomically aborts an unpublished membership claim and discards its chunks", async () => {
    const experiments = atomicCollection(experiment());
    const chunks = chunkCollection();
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        historyCollection() as unknown as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunks as unknown as Collection,
    });
    const nextRequests = requestVector(4_000);

    const claimed = await store.replaceMembership({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      expectedRevisionNumber: 1,
      expectedExperimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      nextExperimentRevisionId: "revision-2",
      nextExperimentExecutionId: "execution-2",
      requests: nextRequests,
      deferPublication: true,
    });
    const nextPayload = claimed?.execution.rollover?.nextExecution.requests;
    expect(nextPayload?.storage).toBe("chunked");
    expect(chunks.documents.size).toBeGreaterThan(0);

    const aborted = await store.abortMembershipReplacement({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentExecutionId: "execution-1",
      nextExperimentExecutionId: "execution-2",
      nextExperimentRevisionId: "revision-2",
    });

    expect(aborted).toMatchObject({
      revision: { experimentRevisionId: "revision-1" },
      execution: {
        experimentExecutionId: "execution-1",
        version: 3,
      },
    });
    expect(aborted?.execution.rollover).toBeUndefined();
    expect(aborted?.execution.frozenAt).toBeUndefined();
    expect(chunks.documents.size).toBe(0);
  });

  it("allows exactly one winner in a writer-freezer race", async () => {
    const experiments = atomicCollection(experiment());
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: {} as Collection,
    });

    const [writer, freezer] = await Promise.all([
      store.claimHandler({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
        handlerId: "report",
        handlerVersion: 1,
        claimToken: "claim-1",
      }),
      store.freezeCurrent({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
      }),
    ]);

    expect([writer, freezer].filter(Boolean)).toHaveLength(1);
    expect(experiments.current().execution.version).toBe(2);
    expect(experiments.current().stateVersion).toBe(3);
  });

  it("requires project, execution identity, and version on claims", async () => {
    const experiments = atomicCollection(experiment());
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: {} as Collection,
    });
    await expect(
      store.claimHandler({
        projectId: "wrong-project",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
        handlerId: "report",
        handlerVersion: 1,
        claimToken: "claim-1",
      }),
    ).resolves.toBeNull();
    await expect(
      store.claimHandler({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "wrong-execution",
        expectedExecutionVersion: 1,
        handlerId: "report",
        handlerVersion: 1,
        claimToken: "claim-1",
      }),
    ).resolves.toBeNull();
  });

  it("rejects stale completion tokens and accepts the exact claimed version", async () => {
    const experiments = atomicCollection(experiment());
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: {} as Collection,
    });
    const claimed = await store.claimHandler({
      projectId: "project-1",
      experimentId: "experiment-1",
      experimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      handlerId: "report",
      handlerVersion: 1,
      claimToken: "claim-1",
    });
    expect(claimed?.execution.version).toBe(2);

    await expect(
      store.completeHandler({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 2,
        handlerId: "report",
        handlerVersion: 1,
        claimToken: "stale-token",
        status: "done",
      }),
    ).resolves.toBeNull();

    const completed = await store.completeHandler({
      projectId: "project-1",
      experimentId: "experiment-1",
      experimentExecutionId: "execution-1",
      expectedExecutionVersion: 2,
      handlerId: "report",
      handlerVersion: 1,
      claimToken: "claim-1",
      status: "done",
      report: {
        reportId: "report-1",
        url: "/api/v1/reports/report-1",
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
      },
    });
    expect(completed?.execution.handlerSummary.report).toMatchObject({
      status: "done",
      version: 1,
      claimToken: "claim-1",
    });
    expect(completed?.execution.report).toEqual({
      reportId: "report-1",
      url: "/api/v1/reports/report-1",
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    });
    expect(experiments.current().execution).toMatchObject({
      handlerSummary: {
        report: {
          status: "done",
          version: 1,
          claimToken: "claim-1",
        },
      },
      report: {
        reportId: "report-1",
        url: "/api/v1/reports/report-1",
      },
    });
  });

  it("serializes request-state writers against the freezer", async () => {
    const experiments = atomicCollection(experiment());
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: {} as Collection,
    });
    const projected = [
      {
        requestId: "request-1",
        runId: "run-1",
        dependencies: [
          { handlerId: "observations", state: "ready" as const },
        ],
        blockers: [],
      },
    ];

    const [writer, freezer] = await Promise.all([
      store.casUpdateRequestStates({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
        updateId: "projection-1",
        requests: projected,
      }),
      store.freezeCurrent({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
      }),
    ]);

    const writerWon = writer.status === "applied";
    expect(writerWon || freezer !== null).toBe(true);
    expect(writerWon && freezer !== null).toBe(false);
    if (writerWon) {
      expect(writer.requests).toEqual(projected);
      expect(writer.experiment.execution.requests.storage).toBe("inline");
      expect(writer.experiment.execution.version).toBe(3);
    } else {
      expect(writer).toMatchObject({ status: "stale" });
      expect(freezer?.execution.frozenAt).toBeInstanceOf(Date);
    }
  });

  it("rejects request/run vector changes as an invariant violation", async () => {
    const experiments = atomicCollection(experiment());
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: {} as Collection,
    });

    await expect(
      store.casUpdateRequestStates({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
        updateId: "projection-invalid",
        requests: [
          {
            requestId: "request-1",
            runId: "different-run",
            dependencies: [],
            blockers: [],
          },
        ],
      }),
    ).resolves.toMatchObject({
      status: "invariant",
      message:
        "Request-state update cannot change the immutable request/run vector",
    });
  });

  it("surfaces a root publication fault and resumes the same update id", async () => {
    const experiments = atomicCollection(experiment());
    experiments.failOnFindOneAndUpdate(2);
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: {} as Collection,
    });
    const projected = [
      {
        requestId: "request-1",
        runId: "run-1",
        dependencies: [
          { handlerId: "observations", state: "ready" as const },
        ],
        blockers: [],
      },
    ];
    const input = {
      projectId: "project-1",
      experimentId: "experiment-1",
      experimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      updateId: "projection-retry",
      requests: projected,
    };

    await expect(store.casUpdateRequestStates(input)).resolves.toMatchObject({
      status: "partial-failure",
      updateId: "projection-retry",
      retryable: true,
      message: "injected root publication failure",
    });
    expect(
      experiments.current().execution.requestStateUpdate?.updateId,
    ).toBe("projection-retry");

    const repaired = await store.casUpdateRequestStates(input);
    expect(repaired.status).toBe("applied");
    if (repaired.status !== "applied") throw new Error("expected applied");
    expect(repaired.requests).toEqual(projected);
    expect(
      repaired.experiment.execution.requestStateUpdate,
    ).toBeUndefined();
  });

  it("publishes the same projection semantics through a chunked execution", async () => {
    const chunks = chunkCollection();
    const payloadStore = new FixedPayloadStore(
      chunks as unknown as Collection<Document>,
    );
    const entries: ExperimentRequestState[] = Array.from(
      { length: 70 },
      (_, index) => ({
        requestId: `request-${index}`,
        runId: `run-${index}`,
        dependencies: [],
        blockers: [],
      }),
    );
    const identity = {
      projectId: "project-1",
      experimentId: "experiment-1",
      ownerId: "execution-1",
      generation: 1,
    };
    const payload = await payloadStore.prepareRequests({
      identity,
      entries,
      inlineDocument: (value) => ({
        value,
        padding: "x".repeat(256 * 1024),
      }),
    });
    if (payload.storage !== "chunked") throw new Error("expected chunked");
    const root = experiment();
    root.revision.memberCount = entries.length;
    root.execution.requests = payload;
    root.execution.vectorFingerprint =
      fingerprintExperimentRequestVector(entries);
    const experiments = atomicCollection(root);
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: chunks as unknown as Collection,
    });
    const projected = entries.map((entry) => ({
      ...entry,
      dependencies: [
        { handlerId: "observations", state: "ready" as const },
      ],
    }));

    const result = await store.casUpdateRequestStates({
      projectId: "project-1",
      experimentId: "experiment-1",
      experimentExecutionId: "execution-1",
      expectedExecutionVersion: 1,
      updateId: "chunked-projection",
      requests: projected,
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected applied");
    const updatedPayload = result.experiment.execution.requests;
    expect(updatedPayload.storage).toBe("chunked");
    if (updatedPayload.storage !== "chunked") {
      throw new Error("expected chunked");
    }
    expect(updatedPayload.bucketCount).toBe(payload.bucketCount);
    expect(updatedPayload.assignmentVersion).toBe(payload.assignmentVersion);
    expect(updatedPayload.chunkIds).toEqual(payload.chunkIds);
    expect(
      await payloadStore.readRequests(identity, updatedPayload),
    ).toEqual(projected);
  });
});
