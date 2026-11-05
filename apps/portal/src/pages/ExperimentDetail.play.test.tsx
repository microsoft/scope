// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { render, within } from "@testing-library/react";
import { beforeAll, describe, it, vi } from "vitest";
import type {
  ExperimentExecutionView,
  ExperimentView,
} from "@/lib/experiments";

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      getExperiment: vi.fn(),
      listExperimentExecutions: vi.fn(),
      getExperimentExecution: vi.fn(),
      retryExperiment: vi.fn(),
    },
  };
});

import { api } from "@/lib/api";
import experimentDetailMeta, {
  AttemptSelectionAndRunsTable,
} from "./ExperimentDetail.stories";

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

class IntersectionObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: IntersectionObserverMock,
  });

  const currentExecution: ExperimentExecutionView = {
    experimentExecutionId: "execution-current",
    attemptNumber: 2,
    readiness: "done",
    requestCount: 1,
    requests: [
      {
        requestId: "request-current",
        runId: "run-current",
        task: "Implement the current benchmark task",
        status: "done",
        outcome: "success",
      },
    ],
    handlerProgress: {},
    blocking: [],
    createdAt: "2026-10-16T10:00:00.000Z",
  };
  const historicalExecution: ExperimentExecutionView = {
    experimentExecutionId: "execution-history",
    attemptNumber: 1,
    readiness: "failed",
    requestCount: 1,
    requests: [
      {
        requestId: "request-history",
        runId: "run-history",
        task: "Inspect the historical benchmark task",
        status: "done",
        outcome: "failure",
      },
    ],
    handlerProgress: {},
    blocking: [],
    createdAt: "2026-10-15T10:00:00.000Z",
  };
  const experiment: ExperimentView = {
    experimentId: "experiment-demo",
    projectId: "demo-project",
    metadata: { name: "Profile comparison" },
    revision: {
      experimentRevisionId: "revision-demo",
      revisionNumber: 1,
      memberCount: 1,
    },
    execution: currentExecution,
    readiness: "done",
    blocking: [],
    createdRequestIds: ["request-current"],
    createdAt: "2026-10-16T09:00:00.000Z",
  };

  vi.mocked(api.getExperiment).mockResolvedValue(experiment);
  vi.mocked(api.listExperimentExecutions).mockResolvedValue({
    items: [currentExecution, historicalExecution],
  });
  vi.mocked(api.getExperimentExecution).mockResolvedValue(
    historicalExecution,
  );
});

describe("ExperimentDetail stories", () => {
  it("runs the attempt-selection interaction", async () => {
    const StoryRender = experimentDetailMeta.render;
    if (!StoryRender) throw new Error("Experiment detail story is missing render");
    const { container } = render(<StoryRender />);
    const play = AttemptSelectionAndRunsTable.play as unknown as
      | ((context: {
          canvas: ReturnType<typeof within>;
          canvasElement: HTMLElement;
        }) => Promise<void>)
      | undefined;
    await play?.({
      canvas: within(container),
      canvasElement: container,
    });
  });
});
