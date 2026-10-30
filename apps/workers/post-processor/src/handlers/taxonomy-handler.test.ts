// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import {
  createPromptExecutorFactory,
  TaxonomyHandler,
} from "./taxonomy-handler.js";
import type { PromptExecutor } from "taxonomy-engine";
import { taxonomyContentSha256 } from "shared";

const promptElement = {
  schema_version: "scope/taxonomy/v1" as const,
  id: "beh-wrong-discovery",
  label: "Wrong Discovery",
  implementation: { type: "prompt" as const, prompt: "Assess wrong discovery." },
  preconditions: {
    requires_recorded_discovery: true,
    requires_complete_trajectory: true,
    requires_task: true,
  },
  output: {
    evidence_roles: {
      discovery: {
        type: "scope.discovery",
        max: 1,
        description: "Exact recorded discovery.",
      },
    },
  },
};

function atifWithDiscoveries(count: number) {
  return {
    schema_version: "ATIF-v1.7",
    session_id: "session-1",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [
      { step_id: 1, source: "user", message: "Implement merge sort." },
      ...Array.from({ length: count }, (_, index) => ({
        step_id: index + 2,
        source: "agent",
        message: `Discovery ${index + 1}`,
        extra: {
          scope: {
            discoveries: [
              { source_id: `wrong-${index + 1}`, extension_point: "weather" },
            ],
          },
        },
      })),
    ],
    extra: {
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: "complete",
        task: "Implement merge sort.",
        run: {
          id: "run-1",
          scenario_id: "scenario-1",
          scenario_label: "Scenario",
          profile_id: "profile-1",
          profile_label: "Profile",
        },
        available_sources: Array.from({ length: count }, (_, index) => ({
          id: `wrong-${index + 1}`,
          label: `Wrong ${index + 1}`,
          surface_id: "surface-mcp",
        })),
      },
    },
  };
}

function acceptanceContext(input: {
  sourceType: "builtin" | "user";
  occurrenceCount: number;
  deterministic?: boolean;
}) {
  const elementContent = input.deterministic
    ? {
        ...promptElement,
        id: "beh-discovered",
        label: "Discovered",
        implementation: {
          type: "deterministic" as const,
          handler: "scope/discovered-v1",
          config: {},
        },
        preconditions: {
          requires_recorded_discovery: false,
          requires_complete_trajectory: false,
          requires_task: false,
        },
      }
    : promptElement;
  const taxonomyContent = {
    schema_version: "scope/taxonomy/v1" as const,
    id: input.sourceType === "builtin" ? "ax-taxonomy" : "user-managed",
    version: "1.0.0",
    surfaces: [{ id: "surface-mcp", label: "MCP" }],
    elements: [{ ref: `${elementContent.id}@r1` }],
  };
  const taxonomyRevision = {
    ...taxonomyContent,
    _id: "taxonomy-revision-1",
    taxonomyId: "taxonomy-root-1",
    projectId: "project-1",
    sourceType: input.sourceType,
    revision: 1,
    ref: `${taxonomyContent.id}@r1`,
    contentSha256: taxonomyContentSha256(taxonomyContent),
    createdAt: new Date(),
  };
  const elementRevision = {
    ...elementContent,
    _id: "element-revision-1",
    elementId: "element-root-1",
    projectId: "project-1",
    sourceType: input.sourceType,
    revision: 1,
    ref: `${elementContent.id}@r1`,
    contentSha256: taxonomyContentSha256(elementContent),
    createdAt: new Date(),
  };
  const experiment = {
    _id: "experiment-1",
    experimentId: "experiment-1",
    projectId: "project-1",
    execution: {
      experimentExecutionId: "execution-1",
      taxonomy: {
        taxonomyRevisionId: taxonomyRevision._id,
        ref: taxonomyRevision.ref,
        contentSha256: taxonomyRevision.contentSha256,
      },
    },
  };
  const collection = {
    findOne: vi.fn(async () => ({
      _id: "request-1",
      projectId: "project-1",
      experimentId: "experiment-1",
      scenario: { task: "Implement merge sort." },
      model: "claude-haiku-4.5",
      reasoningEffort: "xhigh",
      run: {
        _id: "run-1",
        attemptNumber: 1,
        status: "done",
        turns: [{ iteration: 1, atifUrl: "https://blob/atif.json" }],
      },
    })),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
  };
  const db = {
    collection: vi.fn((name: string) => ({
      findOne: vi.fn(async () => {
        if (name === "experiments") return experiment;
        if (name === "taxonomy-revisions") return taxonomyRevision;
        if (name === "taxonomy-element-revisions") return elementRevision;
        return null;
      }),
    })),
  };
  const blobStorage = {
    downloadJson: vi.fn(async () => atifWithDiscoveries(input.occurrenceCount)),
    uploadBuffer: vi.fn(async () => "https://blob/result.json.gz"),
  };
  return { collection, db, blobStorage };
}

describe("TaxonomyHandler", () => {
  it("uses only the dedicated Taxonome model and omits reasoning effort", async () => {
    const close = vi.fn(async () => undefined);
    const openTransport = vi.fn(async () => ({
      complete: vi.fn(),
      close,
    }));
    const factory = createPromptExecutorFactory({
      environment: {
        TAXONOME_MODEL: "taxonome-model",
        MODEL: "coding-model",
        REASONING_EFFORT: "xhigh",
      },
      openTransport,
    });

    const lease = await factory(true);
    expect(openTransport).toHaveBeenCalledWith(
      "taxonome-model",
      { reasoningEffort: false },
    );
    expect(lease.executor).toBeDefined();
    await lease.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses the dedicated default when no Taxonome model is configured", async () => {
    const openTransport = vi.fn(async () => ({
      complete: vi.fn(),
      close: vi.fn(async () => undefined),
    }));
    const factory = createPromptExecutorFactory({
      environment: {
        MODEL: "claude-haiku-4.5",
        REASONING_EFFORT: "high",
      },
      openTransport,
    });

    await factory(true);
    expect(openTransport).toHaveBeenCalledWith(
      "claude-haiku-4.5",
      { reasoningEffort: false },
    );
  });

  it("does not open a Copilot transport for deterministic elements", async () => {
    const openTransport = vi.fn();
    const factory = createPromptExecutorFactory({ openTransport });

    const lease = await factory(false);

    expect(openTransport).not.toHaveBeenCalled();
    expect(lease.executor).toBeUndefined();
    await expect(lease.close()).resolves.toBeUndefined();
  });

  it("does not initialize a prompt executor for runs without a taxonomy", async () => {
    const executorFactory = vi.fn();
    const log = vi.fn(async () => undefined);
    const handler = new TaxonomyHandler(executorFactory);

    await handler.process(
      { type: "taxonomy", requestId: "request-1", runId: "run-1" },
      {
        blobStorage: {} as never,
        collection: {
          findOne: vi.fn(async () => ({
            _id: "request-1",
            projectId: "project-1",
            scenario: { task: "Test task" },
            run: { _id: "run-1", attemptNumber: 1, status: "done" },
          })),
        } as never,
        criteriaCollection: {} as never,
        log,
      },
    );

    expect(executorFactory).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "info",
      "Run is not attached to an Experiment; skipping Taxonome",
    );
  });

  it("publishes a user-managed prompt result with exactly three occurrences using a fake executor", async () => {
    const context = acceptanceContext({ sourceType: "user", occurrenceCount: 3 });
    const executor: PromptExecutor = {
      evaluate: vi.fn(async () => ({
        status: "succeeded" as const,
        attempts: [{
          attempt: 1 as const,
          kind: "initial" as const,
          outcome: "succeeded" as const,
        }],
        candidate: {
          state: "completed",
          observed: true,
          occurrences: [1, 2, 3].map((step) => ({
            evidence: [{
              role: "discovery",
              path: `$.steps[${step}].extra.scope.discoveries[0]`,
            }],
          })),
        },
      })),
    };
    const factory = vi.fn(async () => ({
      executor,
      close: async () => undefined,
    }));
    const handler = new TaxonomyHandler(factory);

    await handler.process(
      { type: "taxonomy", requestId: "request-1", runId: "run-1" },
      {
        blobStorage: context.blobStorage as never,
        collection: context.collection as never,
        criteriaCollection: {} as never,
        db: context.db as never,
        claimToken: "claim-1",
        log: vi.fn(async () => undefined),
      },
    );

    expect(factory).toHaveBeenCalledWith(true);
    expect(context.blobStorage.uploadBuffer).toHaveBeenCalledWith(
      "request-1/runs/run-1/taxonomy-evaluation/claim-1/result.json.gz",
      expect.any(Buffer),
      "application/json",
      "gzip",
    );
    expect(context.collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "request-1",
        "run._id": "run-1",
        "run.handlerStatus.pp-taxonomy.claimToken": "claim-1",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "run.taxonomyEvaluation": expect.objectContaining({
            url: "https://blob/result.json.gz",
          }),
        }),
      }),
    );
  });

  it("evaluates an exact built-in revision directly without copying it", async () => {
    const context = acceptanceContext({ sourceType: "builtin", occurrenceCount: 1 });
    const executor: PromptExecutor = {
      evaluate: vi.fn(async () => ({
        status: "succeeded" as const,
        attempts: [{
          attempt: 1 as const,
          kind: "initial" as const,
          outcome: "succeeded" as const,
        }],
        candidate: {
          state: "completed",
          observed: true,
          occurrences: [{
            evidence: [{
              role: "discovery",
              path: "$.steps[1].extra.scope.discoveries[0]",
            }],
          }],
        },
      })),
    };
    const handler = new TaxonomyHandler(async () => ({
      executor,
      close: async () => undefined,
    }));

    await handler.process(
      { type: "taxonomy", requestId: "request-1", runId: "run-1" },
      {
        blobStorage: context.blobStorage as never,
        collection: context.collection as never,
        criteriaCollection: {} as never,
        db: context.db as never,
        claimToken: "claim-builtin",
        log: vi.fn(async () => undefined),
      },
    );

    expect(context.db.collection).toHaveBeenCalledWith("taxonomy-revisions");
    expect(context.blobStorage.uploadBuffer).toHaveBeenCalledOnce();
  });

  it("does not initialize a model executor for a deterministic-only taxonomy", async () => {
    const context = acceptanceContext({
      sourceType: "builtin",
      occurrenceCount: 1,
      deterministic: true,
    });
    const factory = vi.fn(async () => ({
      close: async () => undefined,
    }));
    const handler = new TaxonomyHandler(factory);

    await handler.process(
      { type: "taxonomy", requestId: "request-1", runId: "run-1" },
      {
        blobStorage: context.blobStorage as never,
        collection: context.collection as never,
        criteriaCollection: {} as never,
        db: context.db as never,
        claimToken: "claim-code",
        log: vi.fn(async () => undefined),
      },
    );

    expect(factory).toHaveBeenCalledWith(false);
    expect(context.blobStorage.uploadBuffer).toHaveBeenCalledOnce();
  });
});
