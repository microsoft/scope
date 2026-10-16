// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    listAvailableReportModels: vi.fn(async () => []),
    createReportTemplate: vi.fn(async (body: Record<string, unknown>) => ({
      _id: "template-document-1",
      projectId: "project-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...body,
    })),
  },
}));

import { api } from "@/lib/api";
import { CreateReportTemplate } from "./CreateReportTemplate";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CreateReportTemplate", () => {
  it("creates an automatically triggered submission-scoped template", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/reports/templates/new"]}>
          <Routes>
            <Route
              path="/reports/templates/new"
              element={<CreateReportTemplate />}
            />
            <Route
              path="/reports/templates/:id"
              element={<div>Template created</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await userEvent.type(screen.getByLabelText("Name *"), "Submission Summary");
    await userEvent.type(
      screen.getByLabelText("User Prompt *"),
      "Summarize the exact submission attempt.",
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Report scope" }));
    await userEvent.click(
      within(await screen.findByRole("listbox")).getByText(
        "Submission attempt",
      ),
    );

    expect(
      screen.getByText(
        "Runs automatically once the submission attempt and its generated evidence are complete.",
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("combobox", { name: "Trigger" }).textContent,
    ).toContain("Always");

    await userEvent.click(
      screen.getByRole("button", { name: "Create Template" }),
    );

    expect(api.createReportTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "submission-summary",
        name: "Submission Summary",
        subject: "submission",
        userPrompt: "Summarize the exact submission attempt.",
      }),
    );
    expect(await screen.findByText("Template created")).toBeDefined();
  });
});
