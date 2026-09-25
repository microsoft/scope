// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillDocument } from "@/types";

const skills = [
  {
    _id: "azure/cosmos-kit/cosmos-query",
    name: "Cosmos query",
    description: "Query Azure Cosmos DB",
  },
  {
    _id: "azure/cosmos-kit/cosmos-index",
    name: "Cosmos index",
    description: "Tune Azure Cosmos DB indexes",
  },
] as SkillDocument[];

const listSkills = vi.fn(async () => skills);
const searchExternalSkills = vi.fn(async (_query: string, _limit?: number) => []);
const listSkillRevisions = vi.fn(async (_slug: string) => []);

vi.mock("@/lib/api", () => ({
  api: {
    listSkills: () => listSkills(),
    searchExternalSkills: (query: string, limit?: number) => searchExternalSkills(query, limit),
    listSkillRevisions: (slug: string) => listSkillRevisions(slug),
  },
}));

import { SkillPicker } from "./SkillPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function PickerHarness() {
  const [selected, setSelected] = useState<string[]>([]);
  return <SkillPicker selected={selected} onChange={setSelected} />;
}

function renderPicker() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PickerHarness />
    </QueryClientProvider>,
  );
}

describe("SkillPicker", () => {
  it("keeps the search and matching results open while selecting several skills", async () => {
    renderPicker();
    const input = await screen.findByPlaceholderText("Search for skills…");

    fireEvent.change(input, { target: { value: "cosmos" } });
    fireEvent.click(await screen.findByRole("button", { name: /cosmos-query/i }));

    expect((input as HTMLInputElement).value).toBe("cosmos");
    expect(screen.getByRole("button", { name: /cosmos-index/i })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /cosmos-index/i }));
    expect((input as HTMLInputElement).value).toBe("cosmos");
    expect(screen.getAllByText("azure/cosmos-kit/cosmos-query").length).toBeGreaterThan(1);
    expect(screen.getAllByText("azure/cosmos-kit/cosmos-index").length).toBeGreaterThan(1);
  });

  it("opens the scrollable result list above an input near the viewport bottom", async () => {
    const { container } = renderPicker();
    const input = await screen.findByPlaceholderText("Search for skills…");
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 440,
      top: 440,
      right: 400,
      bottom: 476,
      left: 0,
      width: 400,
      height: 36,
      toJSON: () => ({}),
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });

    fireEvent.focus(input);

    const result = await screen.findByRole("button", { name: /cosmos-query/i });
    await waitFor(() => {
      const dropdown = document.querySelector("[data-skill-picker-portal]") as HTMLElement | null;
      expect(dropdown?.parentElement).toBe(document.body);
      expect(container.contains(dropdown)).toBe(false);
      expect(dropdown?.style.position).toBe("fixed");
      expect(dropdown?.style.bottom).toBe("64px");
      expect(dropdown?.style.top).toBe("");
      expect(result.parentElement?.style.maxHeight).toBe("256px");
    });
  });

  it("constrains the portaled result list to the space below the input", async () => {
    renderPicker();
    const input = await screen.findByPlaceholderText("Search for skills…");
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 8,
      top: 8,
      right: 420,
      bottom: 44,
      left: 20,
      width: 400,
      height: 36,
      toJSON: () => ({}),
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 180 });

    fireEvent.focus(input);

    const result = await screen.findByRole("button", { name: /cosmos-query/i });
    await waitFor(() => {
      const dropdown = document.querySelector("[data-skill-picker-portal]") as HTMLElement | null;
      expect(dropdown?.style.top).toBe("48px");
      expect(dropdown?.style.bottom).toBe("");
      expect(result.parentElement?.style.maxHeight).toBe("128px");
    });
  });
});
