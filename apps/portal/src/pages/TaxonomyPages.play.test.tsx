// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/lib/api";
import taxonomyListMeta, {
  EmptyState,
  TableInteractions,
  taxonomyListFixtures,
} from "./TaxonomyList.stories";
import taxonomyDetailMeta, {
  DeletedHistorical,
  ExactOrderedElements,
  taxonomyDetailFixture,
} from "./TaxonomyDetail.stories";

vi.mock("@/lib/api", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      listTaxonomies: vi.fn(),
      getTaxonomyDetail: vi.fn(),
    },
  };
});

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderStory(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <div className="h-[760px]">{node}</div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function runPlay(
  play: unknown,
  container: HTMLElement,
): Promise<void> {
  await (play as ((context: {
    canvas: ReturnType<typeof within>;
    canvasElement: HTMLElement;
  }) => Promise<void>) | undefined)?.({
    canvas: within(container),
    canvasElement: container,
  });
}

describe("taxonomy page stories", () => {
  it("runs the table interaction story", async () => {
    vi.mocked(api.listTaxonomies).mockResolvedValue(taxonomyListFixtures);
    const Story = taxonomyListMeta.component;
    const { container } = renderStory(<Story />);
    await runPlay(TableInteractions.play, container);
  });

  it("runs the empty list story", async () => {
    vi.mocked(api.listTaxonomies).mockResolvedValue([]);
    const Story = taxonomyListMeta.component;
    const { container } = renderStory(<Story />);
    await runPlay(EmptyState.play, container);
  });

  it("runs exact and historical detail interactions", async () => {
    vi.mocked(api.getTaxonomyDetail).mockResolvedValue(
      taxonomyDetailFixture as never,
    );
    const Story = taxonomyDetailMeta.component;
    let rendered = renderStory(<Story taxonomyId="taxonomy-root" />);
    await runPlay(ExactOrderedElements.play, rendered.container);
    cleanup();

    vi.mocked(api.getTaxonomyDetail).mockResolvedValue({
      ...taxonomyDetailFixture,
      taxonomy: {
        ...taxonomyDetailFixture.taxonomy,
        deletedAt: "2026-10-04T00:00:00.000Z",
      },
      selectedRevision: {
        ...taxonomyDetailFixture.selectedRevision,
        _id: "taxonomy-revision-1",
        revision: 1,
        ref: "team-taxonomy@r1",
        elements: [{ ref: "element-b@r1" }],
      },
      elements: [taxonomyDetailFixture.elements[0]],
    } as never);
    rendered = renderStory(
      <Story
        taxonomyId="taxonomy-root"
        revisionId="taxonomy-revision-1"
      />,
    );
    await runPlay(DeletedHistorical.play, rendered.container);
  });
});
