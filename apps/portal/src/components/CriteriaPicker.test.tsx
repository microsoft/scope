// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CriteriaPicker } from "./CriteriaPicker";
import type { CriteriaDocument } from "@/types";

const CRITERIA: CriteriaDocument[] = [
  { id: "crit_a", prompt: "a", createdAt: "" },
  { id: "crit_b", prompt: "b", createdAt: "" },
  { id: "observation_a", prompt: "record a", kind: "observation", createdAt: "" },
];

vi.mock("@/lib/api", () => ({
  api: { listCriteria: vi.fn(async () => CRITERIA) },
}));

afterEach(() => cleanup());

function renderPicker() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CriteriaPicker selected={[]} onChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("CriteriaPicker dropdown", () => {
  // Regression: a modal Radix Dialog sets pointer-events:none on <body>, and the
  // dropdown is portaled to <body>. Without an explicit pointer-events:auto the
  // options render but cannot be clicked, so selecting a criterion silently fails.
  it("renders the portaled dropdown with pointer-events enabled", async () => {
    renderPicker();
    const input = await screen.findByPlaceholderText("Type to search criteria…");
    fireEvent.focus(input);

    const portal = await waitFor(() => {
      const p = document.querySelector("[data-criteria-picker-portal]") as HTMLElement | null;
      if (!p) throw new Error("dropdown not open");
      return p;
    });

    expect(portal.style.pointerEvents).toBe("auto");
  });

  it("adds a criterion when an option is clicked", async () => {
    let selected: string[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CriteriaPicker selected={selected} onChange={(ids) => (selected = ids)} />
      </QueryClientProvider>,
    );
    const input = await screen.findByPlaceholderText("Type to search criteria…");
    fireEvent.focus(input);
    const option = await screen.findByRole("button", { name: /crit_a/ });
    fireEvent.click(option);
    expect(selected).toEqual(["crit_a"]);
  });

  it("uses specialized copy without admitting gate criteria to observation suggestions", async () => {
    const onChange = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CriteriaPicker selected={[]} onChange={onChange} kind="observation" entityLabel="observations" />
      </QueryClientProvider>,
    );
    const input = await screen.findByPlaceholderText("Search observations…");
    fireEvent.focus(input);
    expect(screen.queryByRole("button", { name: /crit_a/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /observation_a/ }));
    expect(onChange).toHaveBeenCalledWith(["observation_a"]);

    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByText("No matching observations")).toBeTruthy();
  });
});
