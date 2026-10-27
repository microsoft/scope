// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import type { PromptType, TaskPrompt } from "@/types";

const getTaskPrompt = vi.fn(async () => ({}) as TaskPrompt);
const getTaskPromptContent = vi.fn(async () => ({ id: "x", text: "blob body" }));

vi.mock("@/lib/api", () => ({
  api: {
    getTaskPrompt: (...args: unknown[]) => getTaskPrompt(...(args as [])),
    getTaskPromptContent: (...args: unknown[]) => getTaskPromptContent(...(args as [])),
  },
}));

import { TaskPromptBadge } from "./TaskPromptBadge";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderBadge(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const basePrompt: TaskPrompt = {
  _id: "abcdef1234567890",
  text: "When creating REST APIs, use TypeScript.",
  createdAt: "2026-01-01T00:00:00.000Z",
  features: [
    { featureId: "f1", detected: true, evaluated: true },
    { featureId: "f2", detected: false, evaluated: true },
  ],
};

describe("TaskPromptBadge navigation + default rendering", () => {
  it("links to the task prompt detail page", () => {
    renderBadge(<TaskPromptBadge taskPromptId="abcdef1234567890" prompt={basePrompt} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/task-prompts/abcdef1234567890");
  });

  it("renders a default label of '<type label> · <short id>'", () => {
    renderBadge(
      <TaskPromptBadge taskPromptId="abcdef1234567890" prompt={{ ...basePrompt, type: "select" }} />,
    );
    const link = screen.getByRole("link");
    expect(link.textContent).toContain("Requirements");
    expect(link.textContent).toContain("abcdef12");
  });

  it("renders custom children instead of the default badge", () => {
    renderBadge(
      <TaskPromptBadge taskPromptId="abcdef1234567890" prompt={basePrompt}>
        <span>Custom trigger</span>
      </TaskPromptBadge>,
    );
    const link = screen.getByRole("link");
    expect(link.textContent).toBe("Custom trigger");
  });

  it("renders content plainly with no link when no id is supplied", () => {
    renderBadge(
      <TaskPromptBadge taskPromptId={undefined}>
        <span>No prompt</span>
      </TaskPromptBadge>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("No prompt")).toBeTruthy();
  });

  it("renders nothing when no id and no children are supplied", () => {
    const { container } = renderBadge(<TaskPromptBadge taskPromptId={null} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("");
  });
});

describe("TaskPromptBadge is type-agnostic", () => {
  const cases: Array<[PromptType | undefined, string]> = [
    ["select", "Requirements"],
    ["build", "Build"],
    ["test", "Test"],
    ["run", "Run"],
    ["deploy", "Deploy"],
    ["agents.md", "AGENTS.md"],
    [undefined, "Requirements"], // legacy untyped ⇒ select label
  ];

  it.each(cases)("renders label %s with identical href + navigation", (type, label) => {
    renderBadge(
      <TaskPromptBadge taskPromptId="abcdef1234567890" prompt={{ ...basePrompt, type }} />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/task-prompts/abcdef1234567890");
    expect(link.textContent).toContain(label);
  });
});

describe("TaskPromptBadge legacy run tooltip", () => {
  it.each(["hover", "keyboard"])("reveals the full inline task on %s without fetching or linking", async (interaction) => {
    const fullTask = `Build an accessible dashboard.\n${"Preserve all evaluation details and project filters. ".repeat(10)}`;
    renderBadge(
      <TaskPromptBadge fallbackText={fullTask}>
        <span>Build an accessible dashboard…</span>
      </TaskPromptBadge>,
    );
    const trigger = screen.getByText("Build an accessible dashboard…");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();

    if (interaction === "hover") {
      await userEvent.hover(trigger);
    } else {
      await userEvent.tab();
    }

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe(fullTask);
    expect(getTaskPrompt).not.toHaveBeenCalled();
    expect(getTaskPromptContent).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("preserves the parent row's click action", async () => {
    const onRowClick = vi.fn();
    renderBadge(
      <div onClick={onRowClick}>
        <TaskPromptBadge fallbackText="Full task text">
          <span>Task…</span>
        </TaskPromptBadge>
      </div>,
    );
    await userEvent.click(screen.getByText("Task…"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it("preserves the linked prompt preview when fallback text is also supplied", async () => {
    const fallbackText = "Inline task from the run";
    renderBadge(
      <TaskPromptBadge
        taskPromptId={basePrompt._id}
        prompt={basePrompt}
        fallbackText={fallbackText}
      />,
    );

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(`/task-prompts/${basePrompt._id}`);
    await userEvent.hover(link);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(basePrompt.text);
    expect(tooltip.textContent).not.toContain(fallbackText);
    expect(getTaskPrompt).not.toHaveBeenCalled();
    expect(getTaskPromptContent).not.toHaveBeenCalled();
  });
});

describe("TaskPromptBadge lazy fetch (no request fan-out)", () => {
  it("never fetches when a preloaded prompt is supplied", async () => {
    renderBadge(<TaskPromptBadge taskPromptId="abcdef1234567890" prompt={basePrompt} />);
    await userEvent.hover(screen.getByRole("link"));
    // Give any (incorrect) query a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(getTaskPrompt).not.toHaveBeenCalled();
  });

  it("does not fetch on mount and fetches exactly once after the tooltip opens", async () => {
    getTaskPrompt.mockResolvedValue(basePrompt);
    renderBadge(<TaskPromptBadge taskPromptId="abcdef1234567890" />);
    expect(getTaskPrompt).not.toHaveBeenCalled();

    await userEvent.hover(screen.getByRole("link"));
    await waitFor(() => expect(getTaskPrompt).toHaveBeenCalledTimes(1));
    expect(getTaskPrompt).toHaveBeenCalledWith("abcdef1234567890");
  });

  it("fetches the blob body for blob-backed prompts (text absent) on open", async () => {
    renderBadge(
      <TaskPromptBadge
        taskPromptId="abcdef1234567890"
        prompt={{ ...basePrompt, text: undefined }}
      />,
    );
    expect(getTaskPromptContent).not.toHaveBeenCalled();

    await userEvent.hover(screen.getByRole("link"));
    await waitFor(() => expect(getTaskPromptContent).toHaveBeenCalledTimes(1));
    // Metadata was preloaded, so the metadata endpoint is never hit.
    expect(getTaskPrompt).not.toHaveBeenCalled();
  });
});
