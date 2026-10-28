// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { expect } from "storybook/test";
import type { Run } from "@/types";
import { RunDetail } from "./RunDetail";

const run: Run = {
  _id: "demo-tab-order",
  id: "demo-tab-order",
  workerType: "coder-acp-copilot",
  createdAt: "2026-01-01T00:00:00.000Z",
  run: {
    _id: "attempt-1",
    attemptNumber: 1,
    status: "done",
    outcome: "succeeded",
    harUrl: "demo.har",
    videoUrls: ["demo.webm"],
    turns: [{
      iteration: 1,
      codingAgentResponse: "Demo task completed.",
      judgeFeedback: "",
      snapshotUrl: "",
      passed: true,
      timestamp: "2026-01-01T00:00:00.000Z",
    }],
  },
};

const meta = {
  title: "Pages/RunDetail",
  component: RunDetail,
  tags: ["ai-generated", "needs-work"],
  parameters: {
    layout: "padded",
    msw: {
      handlers: [
        http.get("/api/v1/requests/demo-tab-order/reports", () => HttpResponse.json([])),
        http.get("/api/v1/requests/demo-tab-order/logs", () =>
          new HttpResponse("event: done\ndata: {}\n\n", {
            headers: { "Content-Type": "text/event-stream" },
          }),
        ),
      ],
    },
  },
  decorators: [
    (Story, context) => {
      const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
      client.setQueryData(["run", run._id], context.parameters.emptyRun
        ? { ...run, run: { ...run.run, status: "done", turns: [], harUrl: undefined, videoUrls: [] } }
        : run);
      client.setQueryData(["run-reports", run._id], []);
      client.setQueryData(["report-templates"], []);
      return (
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/runs/:id/:tab?" element={<Story />} />
            <Route path="*" element={<Navigate to={`/runs/${run._id}`} replace />} />
          </Routes>
        </QueryClientProvider>
      );
    },
  ],
} satisfies Meta<typeof RunDetail>;

export default meta;
type Story = StoryObj<typeof meta>;
type TabPlayContext = Pick<Parameters<NonNullable<Story["play"]>>[0], "canvas">;

export const AllTabs = {
  play: async ({ canvas }: TabPlayContext) => {
    await expect((await canvas.findAllByRole("tab")).map((tab) => tab.textContent)).toEqual([
      "Details", "Turns (1)", "Conversation", "Reports ", "Network", "Tool Calls", "Videos (1)", "Logs",
    ]);
    await expect(canvas.getByRole("tab", { name: "Turns (1)" })).toHaveAttribute("aria-selected", "true");
  },
} satisfies Story;

export const WithoutArtifacts = {
  parameters: { emptyRun: true },
  play: async ({ canvas }: TabPlayContext) => {
    await expect((await canvas.findAllByRole("tab")).map((tab) => tab.textContent)).toEqual([
      "Details", "Turns (0)", "Reports ", "Logs",
    ]);
    await expect(canvas.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  },
} satisfies Story;
