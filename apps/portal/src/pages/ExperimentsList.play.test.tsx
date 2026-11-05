// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { render, within } from "@testing-library/react";
import { beforeAll, describe, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/lib/api";
import experimentsListMeta, {
  SharedListInteractions,
} from "./ExperimentsList.stories";

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      listExperiments: vi.fn(),
    },
  };
});

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
  vi.mocked(api.listExperiments).mockResolvedValue({
    items: [
      {
        experimentId: "experiment-alpha",
        projectId: "demo-project",
        metadata: { name: "Alpha benchmark" },
        revision: {
          experimentRevisionId: "revision-alpha",
          revisionNumber: 1,
          memberCount: 4,
        },
        execution: {
          experimentExecutionId: "execution-alpha",
          attemptNumber: 2,
          requestCount: 4,
          requests: [],
          handlerProgress: {},
          blocking: [],
          createdAt: "2026-10-16T10:00:00.000Z",
        },
        readiness: "done",
        blocking: [],
        createdRequestIds: [],
        createdAt: "2026-10-16T09:00:00.000Z",
      },
      {
        experimentId: "experiment-beta",
        projectId: "demo-project",
        metadata: { name: "Beta benchmark" },
        revision: {
          experimentRevisionId: "revision-beta",
          revisionNumber: 1,
          memberCount: 4,
        },
        execution: {
          experimentExecutionId: "execution-beta",
          attemptNumber: 2,
          requestCount: 4,
          requests: [],
          handlerProgress: {},
          blocking: [],
          createdAt: "2026-10-16T10:00:00.000Z",
        },
        readiness: "blocked",
        blocking: [],
        createdRequestIds: [],
        createdAt: "2026-10-16T09:00:00.000Z",
      },
    ],
  });
});

describe("ExperimentsList stories", () => {
  it("runs the shared-list interaction", async () => {
    const StoryRender = experimentsListMeta.component;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <div className="h-[760px]">
            <StoryRender />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const play = SharedListInteractions.play as unknown as
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
