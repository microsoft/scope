// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Navigate, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { expect, screen, userEvent } from "storybook/test";
import { Toaster } from "@/components/ui/sonner";
import type { Run } from "@/types";
import { RunDetail } from "./RunDetail";

const completedRun: Run = {
  _id: "demo-report-run",
  id: "demo-report-run",
  workerType: "coder-acp-copilot",
  scenario: { task: "Build a sample app", criteria: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  run: { _id: "demo-attempt", attemptNumber: 1, status: "done", outcome: "succeeded" },
};

const handlers = [
  http.get("/api/v1/requests/demo-report-run", () => HttpResponse.json(completedRun)),
  http.get("/api/v1/requests/demo-report-run/reports", () => HttpResponse.json([])),
  http.get("/api/v1/report-templates", () => HttpResponse.json([])),
  http.get("/api/v1/requests/demo-report-run/logs", () => new HttpResponse(
    'event: done\ndata: {"status":"done"}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  )),
];

const meta: Meta<typeof RunDetail> = {
  title: "pages/RunDetailReportFeedback",
  component: RunDetail,
  tags: ["ai-generated", "needs-work"],
  parameters: { layout: "padded" },
  render: () => (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/runs/demo-report-run/reports" replace />} />
        <Route path="/runs/:id/:tab" element={<RunDetail />} />
      </Routes>
      <Toaster />
    </>
  ),
};

export default meta;
type Story = StoryObj<typeof RunDetail>;

export const NoReportsQueued: Story = {
  parameters: {
    msw: {
      handlers: [
        ...handlers,
        http.post("/api/v1/reports/trigger", () => HttpResponse.json(
          { triggered: 0, reports: [] }, { status: 201 },
        )),
      ],
    },
  },
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Generate Report" }));
    const notification = await screen.findByText("No reports queued");
    await expect(notification.closest("[data-sonner-toast]")?.getAttribute("data-type")).toBe("warning");
    await expect(screen.getByText(
      "No active report template trigger matched this run. Review report template triggers and try again.",
    )).toBeTruthy();
  },
};

export const ReportsQueued: Story = {
  parameters: {
    msw: {
      handlers: [
        ...handlers,
        http.post("/api/v1/reports/trigger", () => HttpResponse.json({
          triggered: 1,
          reports: [{ id: "demo-report", requestId: completedRun.id, templateId: "demo-template", status: "pending" }],
        }, { status: 201 })),
      ],
    },
  },
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Generate Report" }));
    const notification = await screen.findByText("1 report(s) queued");
    await expect(notification.closest("[data-sonner-toast]")?.getAttribute("data-type")).toBe("success");
  },
};
