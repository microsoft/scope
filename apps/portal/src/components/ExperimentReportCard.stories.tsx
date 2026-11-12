// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { expect, screen, userEvent, within } from "storybook/test";
import {
  groupExperimentReports,
  resolveExperimentReportSelection,
} from "@/lib/experiment-reports";
import type { Report } from "@/types";
import { ExperimentReportCard } from "./ExperimentReportCard";

const report: Report = {
  _id: "report-1",
  id: "report-1",
  experimentId: "experiment-1",
  experimentExecutionId: "execution-2",
  status: "completed",
  content: "# Experiment readout\n\nFive exact-vector runs were analyzed.",
  reporter: {
    id: "pp-readout",
    name: "Experiment Readout",
    gitHash: "abc",
    model: "gpt-5.4",
    agentId: "copilot-sdk",
    agentVersion: "1.0.0",
  },
  structuredArtifact: {
    schemaId: "scope.experiment-readout",
    schemaVersion: "1.0",
    contentType: "application/json",
    url: "reports/report-1/structured.json",
  },
  createdAt: "2026-01-02T00:00:00.000Z",
};

const historicalReport: Report = {
  ...report,
  _id: "report-0",
  id: "report-0",
  content: "# Previous readout\n\nThe earlier retry output.",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const failedReport: Report = {
  ...report,
  _id: "report-failed",
  id: "report-failed",
  status: "failed",
  content: undefined,
  structuredArtifact: undefined,
  error: "The readout worker stopped before publishing an artifact.",
  createdAt: "2026-01-04T00:00:00.000Z",
};

const qualityReport: Report = {
  ...report,
  _id: "report-quality",
  id: "report-quality",
  templateId: "quality-summary",
  content: "# Quality summary\n\nA second report type.",
  reporter: {
    ...report.reporter!,
    id: "quality-summary",
    name: "Quality Summary",
  },
  createdAt: "2026-01-03T00:00:00.000Z",
};

const completedGroups = groupExperimentReports([report]);
const completedSelection = resolveExperimentReportSelection(completedGroups);

const meta = {
  title: "Experiments/Reports",
  component: ExperimentReportCard,
  args: {
    experimentId: "experiment-1",
    experimentExecutionId: "execution-2",
    attemptNumber: 2,
    groups: completedGroups,
    selection: completedSelection,
    structuredUrl: "/structured.json",
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ExperimentReportCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Completed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Experiment readout" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Structured JSON" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("combobox")).toBeNull();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-toolbar"]'),
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-body"]'),
    ).not.toBeNull();
  },
};

export const Processing: Story = {
  args: {
    groups: [],
    selection: undefined,
    structuredUrl: undefined,
    isProcessing: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Report processing")).toBeVisible();
    await expect(canvas.getByText("Processing")).toBeVisible();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-toolbar"]'),
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-body"]'),
    ).not.toBeNull();
  },
};

export const ErrorWithRetry: Story = {
  args: {
    groups: [],
    selection: undefined,
    structuredUrl: undefined,
    error: "Report service unavailable",
    onRetry: () => undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Report unavailable")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-toolbar"]'),
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-body"]'),
    ).not.toBeNull();
  },
};

export const FailedVersion: Story = {
  args: {
    groups: groupExperimentReports([failedReport]),
    selection: resolveExperimentReportSelection(
      groupExperimentReports([failedReport]),
    ),
    structuredUrl: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Report generation failed")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Structured JSON" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    await expect(
      canvas.getByRole("link", { name: "Direct link" }),
    ).toBeVisible();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-toolbar"]'),
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-body"]'),
    ).not.toBeNull();
  },
};

export const NoArtifact: Story = {
  args: {
    groups: [],
    selection: undefined,
    structuredUrl: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No report available")).toBeVisible();
    await expect(canvas.getByText("No report")).toBeVisible();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-toolbar"]'),
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-body"]'),
    ).not.toBeNull();
  },
};

export const Blocked: Story = {
  args: {
    groups: [],
    selection: undefined,
    structuredUrl: undefined,
    isBlocked: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Report blocked")).toBeVisible();
    await expect(canvas.getByText("Blocked")).toBeVisible();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-toolbar"]'),
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector('[data-slot="experiment-report-body"]'),
    ).not.toBeNull();
  },
};

function InteractiveReports({
  reports,
  initialType,
  initialReportId,
}: {
  reports: Report[];
  initialType?: string;
  initialReportId?: string;
}) {
  const groups = useMemo(() => groupExperimentReports(reports), [reports]);
  const initialSelection = resolveExperimentReportSelection(
    groups,
    initialType,
    initialReportId,
  );
  const [typeKey, setTypeKey] = useState(initialSelection?.group.key);
  const [reportId, setReportId] = useState(initialSelection?.report._id);
  const selection = resolveExperimentReportSelection(
    groups,
    typeKey,
    reportId,
  );

  return (
    <ExperimentReportCard
      experimentId="experiment-1"
      experimentExecutionId="execution-2"
      attemptNumber={2}
      groups={groups}
      selection={selection}
      structuredUrl="/structured.json"
      onReportTypeChange={(nextType) => {
        const group = groups.find((candidate) => candidate.key === nextType);
        setTypeKey(nextType);
        setReportId(group?.reports[0]._id);
      }}
      onReportVersionChange={setReportId}
    />
  );
}

export const RetryHistory: Story = {
  render: () => (
    <InteractiveReports reports={[historicalReport, report]} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Experiment readout" }),
    ).toBeVisible();
    await expect(canvas.getByText("Latest")).toBeVisible();

    await userEvent.click(
      canvas.getByRole("combobox", { name: "Report version" }),
    );
    await userEvent.click(
      await screen.findByRole("option", {
        name: /Version 1 · Historical/,
      }),
    );

    await expect(
      canvas.getByRole("heading", { name: "Previous readout" }),
    ).toBeVisible();
    await expect(canvas.getByText("Historical")).toBeVisible();
  },
};

export const MultipleReportTypes: Story = {
  render: () => (
    <InteractiveReports reports={[historicalReport, report, qualityReport]} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Quality summary" }),
    ).toBeVisible();

    await userEvent.click(
      canvas.getByRole("combobox", { name: "Report type" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Experiment Readout" }),
    );

    await expect(
      canvas.getByRole("heading", { name: "Experiment readout" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("combobox", { name: "Report version" }),
    ).toBeVisible();
  },
};
