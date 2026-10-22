// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import {
  EXPERIMENT_STORAGE_PROFILE_VERSION,
  ExperimentStore,
  FixedPayloadStore,
  fingerprintExperimentPayload,
  type ExperimentDocument,
  type ExperimentExecutionHistoryDocument,
  type ExperimentRequestState,
  type RequestDocument,
  type ServiceHandlerDocument,
} from "shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExperimentCoordinator,
  type ExperimentCoordinatorCollections,
} from "./experiment-coordinator.js";

const now = new Date("2026-01-01T00:00:00.000Z");

function experiment(
  requests: ExperimentRequestState[],
  overrides: Partial<ExperimentDocument["execution"]> = {},
): ExperimentDocument {
  const fingerprint = fingerprintExperimentPayload(requests);
  return {
    _id: "experiment-1",
    experimentId: "experiment-1",
    projectId: "project-1",
    metadata: { name: "Experiment" },
    storageProfileVersion: EXPERIMENT_STORAGE_PROFILE_VERSION,
    stateVersion: 1,
    revision: {
      experimentRevisionId: "revision-1",
      revisionNumber: 1,
      memberCount: requests.length,
      membershipFingerprint: fingerprint,
      definitionFingerprint: "definition-1",
      createdAt: now,
    },
    execution: {
      experimentExecutionId: "execution-1",
      attemptNumber: 1,
      version: 1,
      requests: {
        storage: "inline",
        entryCount: requests.length,
        payloadFingerprint: fingerprint,
        payloadVersion: 1,
        entries: requests,
      },
      vectorFingerprint: fingerprint,
      handlerSummary: {},
      blocking: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    createdAt: now,
    updatedAt: now,
    finalizedAt: now,
  };
}

function cursor<T extends Document>(documents: T[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(documents),
  };
}

function collections(input: {
  requests: RequestDocument[];
  services: ServiceHandlerDocument[];
  updatedExperiments?: ExperimentDocument[];
  currentExperiment?: ExperimentDocument;
}): ExperimentCoordinatorCollections {
  const updates = [...(input.updatedExperiments ?? [])];
  return {
    requests: {
      find: vi.fn().mockReturnValue(cursor(input.requests)),
      updateMany: vi.fn(),
    } as unknown as Collection<RequestDocument>,
    experiments: {
      findOne: vi.fn().mockResolvedValue(input.currentExperiment ?? null),
      findOneAndUpdate: vi.fn().mockImplementation(async () => updates.shift() ?? null),
    } as unknown as Collection<ExperimentDocument>,
    executions: {} as Collection<ExperimentExecutionHistoryDocument>,
    chunks: {} as Collection,
    services: {
      find: vi.fn().mockImplementation((filter: Document) => {
        const type = filter.type;
        return cursor(input.services.filter((service) => service.type === type));
      }),
    } as unknown as Collection<ServiceHandlerDocument>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExperimentCoordinator", () => {
  it("queues ready Experiment reports independently from unused linked templates", async () => {
    const requestState: ExperimentRequestState = {
      requestId: "request-1",
      runId: "run-1",
      dependencies: [],
      blockers: [],
    };
    const initial = experiment([requestState], {
      handlerSummary: {
        "pp-readout": {
          status: "done",
          version: 1,
          updatedAt: now,
        },
      },
      reportTemplates: {},
      report: {
        reportId: "readout-1",
        url: "/api/v1/reports/readout-1",
        updatedAt: now,
      },
    });
    initial.revision.reportTemplateIds = [];
    const always = {
      _id: "always",
      projectId: "project-1",
      id: "always",
      subject: "experiment",
      name: "Always",
      userPrompt: "Summarize",
      trigger: { type: "always" as const },
      enabled: true,
      currentVersionId: "always:v1",
      currentVersion: 1,
      contentFingerprint: "always-fingerprint",
      createdAt: now,
    };
    const linked = {
      ...always,
      _id: "linked",
      id: "linked",
      name: "Linked",
      trigger: {
        type: "run-report-templates" as const,
        reportTemplateIds: ["security"],
      },
      currentVersionId: "linked:v1",
      contentFingerprint: "linked-fingerprint",
    };
    const insertOne = vi.fn().mockResolvedValue({ acknowledged: true });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(
      ExperimentStore.prototype,
      "updateReportTemplateSummaries",
    ).mockImplementation(async (input) => {
      const next = structuredClone(initial);
      next.execution.version = 2;
      next.execution.reportTemplates = input.summaries;
      return next;
    });
    const coordinator = new ExperimentCoordinator(
      {
        requests: {} as Collection<RequestDocument>,
        experiments: {} as Collection<ExperimentDocument>,
        executions: {} as Collection<ExperimentExecutionHistoryDocument>,
        chunks: {} as Collection,
        services: {
          find: vi.fn().mockReturnValue(
            cursor([
              {
                _id: "pp-readout",
                type: "experiment-handler",
                version: 1,
                queue: "queue-readout",
                selector: "readout",
                autoBackfill: false,
                dependsOn: [],
                dependencyMode: "all-runs",
              },
            ]),
          ),
        } as unknown as Collection<ServiceHandlerDocument>,
        reportTemplates: {
          find: vi.fn().mockReturnValue(cursor([always, linked])),
        } as unknown as Collection,
        reportTemplateVersions: {} as Collection,
        reports: {
          insertOne,
          findOne: vi.fn(),
        } as unknown as Collection,
      },
      enqueue,
    );
    const request = {
      _id: "request-1",
      projectId: "project-1",
      scenario: { task: "task", criteria: [] },
      workerType: "worker",
      createdAt: now,
      taskPromptId: "prompt",
      priority: 0,
      run: {
        _id: "run-1",
        attemptNumber: 1,
        status: "done",
        logsUrl: "https://logs",
        reportTemplateIds: [],
      },
    } as RequestDocument;

    const dispatched = await (
      coordinator as unknown as {
        dispatchReadyReportTemplates(
          experiment: ExperimentDocument,
          requests: readonly ExperimentRequestState[],
          requestById: ReadonlyMap<string, RequestDocument>,
        ): Promise<boolean>;
      }
    ).dispatchReadyReportTemplates(
      initial,
      [requestState],
      new Map([[request._id, request]]),
    );

    expect(dispatched).toBe(true);
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: expect.stringMatching(/^experiment-report-/),
        templateId: "always",
        templateVersionId: "always:v1",
        reportVersion: 1,
      }),
    );
    expect(
      vi.mocked(ExperimentStore.prototype.updateReportTemplateSummaries).mock
        .calls[0]?.[0].summaries,
    ).toMatchObject({
      always: { status: "queued", blockers: [] },
      linked: {
        status: "not-applicable",
        blockers: [
          {
            runTemplateId: "security",
            reason: "run-template-unused",
          },
        ],
      },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "pp-readout" }),
      expect.objectContaining({
        type: "experiment-report",
        templateId: "always",
        templateVersionId: "always:v1",
      }),
    );
  });

  it("projects authoritative run status and dispatches an exact execution message", async () => {
    const initialRequest: ExperimentRequestState = {
      requestId: "request-1",
      runId: "run-1",
      dependencies: [],
      blockers: [],
    };
    const projectedRequest: ExperimentRequestState = {
      ...initialRequest,
      dependencies: [
        {
          handlerId: "pp-observations",
          state: "ready",
          version: 3,
          updatedAt: now,
        },
      ],
    };
    const initial = experiment([initialRequest]);
    const projected = experiment([projectedRequest], { version: 2 });
    const queued = experiment([projectedRequest], {
      version: 3,
      handlerSummary: {
        "experiment-processing": {
          status: "queued",
          version: 2,
          claimToken: "claim-1",
          updatedAt: now,
        },
      },
    });

    vi.spyOn(ExperimentStore.prototype, "get").mockResolvedValue(initial);
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([
      initialRequest,
    ]);
    vi.spyOn(
      ExperimentStore.prototype,
      "casUpdateRequestStates",
    ).mockResolvedValue({
      status: "applied",
      experiment: projected,
      requests: [projectedRequest],
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ExperimentCoordinator(
      collections({
        requests: [
          {
            _id: "request-1",
            projectId: "project-1",
            scenario: { task: "task", criteria: [] },
            workerType: "worker",
            createdAt: now,
            taskPromptId: "prompt-1",
            priority: 0,
            run: {
              _id: "run-1",
              attemptNumber: 1,
              status: "done",
              outcome: "failed",
              logsUrl: "https://logs",
              observationResults: [{
                criterionId: "criterion-1",
                evaluated: true,
                passed: false,
                feedback: "Valid negative evidence",
              }],
              handlerStatus: {
                "pp-observations": {
                  status: "done",
                  version: 3,
                  updatedAt: now,
                },
                "unrelated-handler": {
                  status: "failed",
                  version: 1,
                  updatedAt: now,
                  error: "Unrelated failure",
                },
              },
            },
          },
        ],
        services: [
          {
            _id: "pp-observations",
            type: "post-process-handler",
            version: 3,
            queue: "queue-pp-observations",
            selector: "observations",
            autoBackfill: false,
            dependsOn: [],
          },
          {
            _id: "experiment-processing",
            type: "experiment-handler",
            version: 2,
            queue: "queue-experiment-processing",
            selector: "experiment-processing",
            autoBackfill: false,
            dependsOn: ["pp-observations"],
            dependencyMode: "all-runs",
          },
        ],
        updatedExperiments: [queued],
      }),
      enqueue,
    );

    const result = await coordinator.reconcile("project-1", "experiment-1");

    expect(result?.dispatched).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "experiment-processing" }),
      {
        type: "experiment-processing",
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        handlerId: "experiment-processing",
        handlerVersion: 2,
        claimToken: expect.any(String),
        executionVersion: 3,
      },
    );
  });

  it("bounds aggregate execution blockers while retaining exact request projections", async () => {
    const requests: ExperimentRequestState[] = Array.from(
      { length: 40 },
      (_, index) => ({
        requestId: `request-${index}`,
        runId: `run-${index}`,
        dependencies: [],
        blockers: [],
      }),
    );
    const projectedRequests: ExperimentRequestState[] = requests.map(
      (request) => ({
        ...request,
        dependencies: [
          {
            handlerId: "pp-observations",
            state: "waiting",
          },
        ],
        blockers: [
          {
            requestId: request.requestId,
            runId: request.runId,
            handlerId: "pp-observations",
            reason: "dependency-not-ready",
          },
        ],
      }),
    );
    const initial = experiment(requests);
    const projected = experiment(projectedRequests, { version: 2 });
    const bounded = experiment(projectedRequests, {
      version: 3,
      blocking: projectedRequests
        .flatMap((request) => request.blockers)
        .slice(0, 32),
    });
    vi.spyOn(ExperimentStore.prototype, "get")
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(bounded);
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue(
      requests,
    );
    vi.spyOn(
      ExperimentStore.prototype,
      "casUpdateRequestStates",
    ).mockResolvedValue({
      status: "applied",
      experiment: projected,
      requests: projectedRequests,
    });
    const coordinatorCollections = collections({
      requests: requests.map((request) => ({
        _id: request.requestId,
        projectId: "project-1",
        scenario: { task: "task", criteria: [] },
        workerType: "worker",
        createdAt: now,
        taskPromptId: "prompt-1",
        priority: 0,
        run: {
          _id: request.runId,
          attemptNumber: 1,
          status: "done",
          logsUrl: "https://logs",
          handlerStatus: {},
        },
      })),
      services: [
        {
          _id: "pp-observations",
          type: "post-process-handler",
          version: 1,
          queue: "queue-pp-observations",
          selector: "observations",
          autoBackfill: false,
          dependsOn: [],
        },
      ],
      updatedExperiments: [bounded],
    });
    const coordinator = new ExperimentCoordinator(coordinatorCollections);

    const result = await coordinator.reconcile("project-1", "experiment-1");

    expect(result?.experiment.execution.blocking).toHaveLength(32);
    expect(
      vi.mocked(coordinatorCollections.experiments.findOneAndUpdate).mock
        .calls[0]?.[1],
    ).toMatchObject({
      $set: {
        "execution.blocking": bounded.execution.blocking,
      },
    });
    expect(
      vi.mocked(ExperimentStore.prototype.casUpdateRequestStates).mock
        .calls[0]?.[0].requests,
    ).toHaveLength(40);
  });

  it.each([
    {
      name: "failed observations",
      services: [
        {
          _id: "pp-observations",
          type: "post-process-handler" as const,
          version: 1,
          queue: "queue-pp-observations",
          selector: "observations",
          autoBackfill: false,
          dependsOn: [],
        },
      ],
      handlerStatus: {
        "pp-observations": {
          status: "failed" as const,
          version: 1,
          updatedAt: now,
          error: "Observation processing failed",
        },
      },
      expectedState: "failed",
      expectedReason: "dependency-failed",
    },
    {
      name: "dependency-blocked observations",
      services: [
        {
          _id: "observation-prerequisite",
          type: "post-process-handler" as const,
          version: 1,
          queue: "queue-observation-prerequisite",
          selector: "observation-prerequisite",
          autoBackfill: false,
          dependsOn: [],
        },
        {
          _id: "pp-observations",
          type: "post-process-handler" as const,
          version: 1,
          queue: "queue-pp-observations",
          selector: "observations",
          autoBackfill: false,
          dependsOn: ["observation-prerequisite"],
        },
      ],
      handlerStatus: {
        "observation-prerequisite": {
          status: "failed" as const,
          version: 1,
          updatedAt: now,
          error: "Prerequisite failed",
        },
      },
      expectedState: "blocked",
      expectedReason: "dependency-blocked",
    },
  ])("does not dispatch when $name", async ({
    services,
    handlerStatus,
    expectedState,
    expectedReason,
  }) => {
    const initialRequest: ExperimentRequestState = {
      requestId: "request-1",
      runId: "run-1",
      dependencies: [],
      blockers: [],
    };
    const projectedRequest: ExperimentRequestState = {
      ...initialRequest,
      dependencies: [{
        handlerId: "pp-observations",
        state: expectedState as "failed" | "blocked",
      }],
      blockers: [{
        requestId: "request-1",
        runId: "run-1",
        handlerId: "pp-observations",
        reason: expectedReason as "dependency-failed" | "dependency-blocked",
        ...(expectedReason === "dependency-failed"
          ? { error: "Observation processing failed" }
          : {}),
      }],
    };
    const initial = experiment([initialRequest]);
    const projected = experiment([projectedRequest], {
      version: 2,
      blocking: projectedRequest.blockers,
    });
    vi.spyOn(ExperimentStore.prototype, "get").mockResolvedValue(initial);
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([
      initialRequest,
    ]);
    vi.spyOn(
      ExperimentStore.prototype,
      "casUpdateRequestStates",
    ).mockResolvedValue({
      status: "applied",
      experiment: projected,
      requests: [projectedRequest],
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ExperimentCoordinator(
      collections({
        requests: [{
          _id: "request-1",
          projectId: "project-1",
          scenario: { task: "task", criteria: [] },
          workerType: "worker",
          createdAt: now,
          taskPromptId: "prompt-1",
          priority: 0,
          run: {
            _id: "run-1",
            attemptNumber: 1,
            status: "done",
            logsUrl: "https://logs",
            handlerStatus,
          },
        }],
        services: [
          ...services,
          {
            _id: "pp-readout",
            type: "experiment-handler",
            version: 1,
            queue: "queue-pp-readout",
            selector: "readout",
            autoBackfill: false,
            dependsOn: ["pp-observations"],
            dependencyMode: "all-runs",
          },
        ],
      }),
      enqueue,
    );

    const result = await coordinator.reconcile("project-1", "experiment-1");

    expect(result?.dispatched).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-enqueues a dropped notice without changing its exact identity", async () => {
    const requestState: ExperimentRequestState = {
      requestId: "request-1",
      runId: "run-1",
      dependencies: [
        {
          handlerId: "pp-observations",
          state: "ready",
          updatedAt: now,
        },
      ],
      blockers: [],
    };
    const queuedAt = new Date(Date.now() - 60_000);
    const current = experiment([requestState], {
      version: 7,
      handlerSummary: {
        "experiment-processing": {
          status: "queued",
          version: 2,
          claimToken: "claim-original",
          updatedAt: queuedAt,
        },
      },
    });
    vi.spyOn(ExperimentStore.prototype, "get").mockResolvedValue(current);
    vi.spyOn(FixedPayloadStore.prototype, "readRequests").mockResolvedValue([
      requestState,
    ]);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ExperimentCoordinator(
      collections({
        requests: [
          {
            _id: "request-1",
            projectId: "project-1",
            scenario: { task: "task", criteria: [] },
            workerType: "worker",
            createdAt: now,
            taskPromptId: "prompt-1",
            priority: 0,
            run: {
              _id: "run-1",
              attemptNumber: 1,
              status: "done",
              logsUrl: "https://logs",
              handlerStatus: {
                "pp-observations": {
                  status: "done",
                  updatedAt: now,
                },
              },
            },
          },
        ],
        services: [
          {
            _id: "pp-observations",
            type: "post-process-handler",
            version: 1,
            queue: "queue-pp-observations",
            selector: "observations",
            autoBackfill: false,
            dependsOn: [],
          },
          {
            _id: "experiment-processing",
            type: "experiment-handler",
            version: 2,
            queue: "queue-experiment-processing",
            selector: "experiment-processing",
            autoBackfill: false,
            dependsOn: ["pp-observations"],
            dependencyMode: "all-runs",
          },
        ],
      }),
      enqueue,
    );

    const result = await coordinator.reconcile("project-1", "experiment-1");

    expect(result?.dispatched).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        experimentExecutionId: "execution-1",
        executionVersion: 7,
        claimToken: "claim-original",
      }),
    );
  });

  it("finalizes an interrupted pending creation before marking its requests", async () => {
    const requestState: ExperimentRequestState = {
      requestId: "request-1",
      runId: "run-1",
      dependencies: [],
      blockers: [],
    };
    const pending = experiment([requestState]);
    delete pending.finalizedAt;
    const finalized = { ...pending, finalizedAt: now };
    const experimentCollections = collections({
      requests: [
        {
          _id: "request-1",
          projectId: "project-1",
          scenario: { task: "task", criteria: [] },
          workerType: "worker",
          createdAt: now,
          taskPromptId: "prompt-1",
          priority: 0,
          experimentId: "experiment-1",
          experimentExpectedRequestCount: 1,
          experimentRequestIndex: 0,
          experimentInitialRunId: "run-1",
          run: {
            _id: "run-1",
            attemptNumber: 1,
            status: "pending",
            logsUrl: "https://logs",
          },
        },
      ],
      services: [],
      currentExperiment: pending,
    });
    const finalize = vi
      .spyOn(ExperimentStore.prototype, "finalizeCreation")
      .mockResolvedValue(finalized);
    const coordinator = new ExperimentCoordinator(experimentCollections);

    const recovered = await coordinator.recoverInterruptedCreations();

    expect(recovered).toBe(1);
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        experimentId: "experiment-1",
        expectedExperimentExecutionId: "execution-1",
        expectedStateVersion: 1,
      }),
    );
    expect(experimentCollections.requests.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        experimentId: "experiment-1",
      }),
      { $set: { experimentFinalizedAt: expect.any(Date) } },
    );
  });
});
