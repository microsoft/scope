// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  SubmissionReports,
  reportId,
} from "@/pages/SubmissionDetail";
import type {
  Report,
  SubmissionRunAttempt,
} from "@/types";

const attempt: SubmissionRunAttempt = {
  _id: "submission-run-current",
  attemptNumber: 2,
  vectorFingerprint: "vector-current",
  requests: [{ requestId: "request-1", runId: "run-1" }],
  dependencyProjection: [],
  blocking: [],
  handlerStatus: {
    "pp-readout": { status: "done", version: 1 },
  },
  report: { reportId: "report-readout" },
  createdAt: "2026-01-02T00:00:00.000Z",
};

const readoutReport: Report = {
  _id: "report-readout",
  id: "report-readout",
  submissionId: "submission-1",
  submissionRunId: attempt._id,
  status: "completed",
  content: "# Submission report\n\nFive runs completed successfully.",
  reporter: {
    id: "pp-readout",
    name: "Submission Readout",
    gitHash: "abc",
    model: "gpt-5.4",
    agentId: "copilot",
    agentVersion: "1.0.0",
  },
  structuredArtifact: {
    schemaId: "scope.submission-readout",
    schemaVersion: "1.0",
    contentType: "application/json",
    url: "reports/report-readout/structured.json",
  },
  createdAt: "2026-01-02T00:00:00.000Z",
};

const templateReport: Report = {
  _id: "report-executive",
  id: "report-executive",
  submissionId: "submission-1",
  submissionRunId: attempt._id,
  templateId: "executive-summary",
  status: "completed",
  content: "# Executive summary\n\nA concise template-based view.",
  createdAt: "2026-01-02T01:00:00.000Z",
};

function ReportTypesStory({ reports }: { reports: Report[] }) {
  const [selected, setSelected] = useState(reports[0]);
  return (
    <SubmissionReports
      reports={reports}
      selectedReport={selected}
      currentReportId={reportId(readoutReport)}
      isCurrentAttempt
      readiness="done"
      onSelect={setSelected}
      onShowProcessing={() => undefined}
    />
  );
}

const meta = {
  title: "Submissions/Submission Reports",
  component: ReportTypesStory,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ReportTypesStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OneReportType: Story = {
  args: { reports: [readoutReport] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Submission Readout" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "Submission report" }),
    ).toBeVisible();
  },
};

export const MultipleReportTypes: Story = {
  args: { reports: [readoutReport, templateReport] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const executiveTab = canvas.getByRole("tab", { name: "Executive Summary" });
    await expect(executiveTab).toHaveClass("rounded-b-none");
    await userEvent.click(executiveTab);
    await expect(executiveTab).toHaveAttribute("data-state", "active");
    await expect(
      canvas.getByRole("heading", { name: "Executive summary" }),
    ).toBeVisible();
  },
};
