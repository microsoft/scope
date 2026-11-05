// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  groupExperimentReports,
  resolveExperimentReportSelection,
} from "@/lib/experiment-reports";
import type { Report } from "@/types";
import { ExperimentReportCard } from "./ExperimentReportCard";

const completedReport: Report = {
  _id: "report-completed",
  id: "report-completed",
  experimentId: "experiment-1",
  experimentExecutionId: "execution-2",
  status: "completed",
  content: "# Completed report\n\nExact evidence.",
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
    url: "reports/report-completed/structured.json",
  },
  createdAt: "2026-10-16T10:00:00.000Z",
};

const failedReport: Report = {
  ...completedReport,
  _id: "report-failed",
  id: "report-failed",
  status: "failed",
  content: undefined,
  structuredArtifact: undefined,
  error: "Generation failed.",
};

const baseProps: ComponentProps<typeof ExperimentReportCard> = {
  experimentId: "experiment-1",
  experimentExecutionId: "execution-2",
  attemptNumber: 2,
  groups: [],
};

function reportProps(
  report: Report,
): ComponentProps<typeof ExperimentReportCard> {
  const groups = groupExperimentReports([report]);
  return {
    ...baseProps,
    groups,
    selection: resolveExperimentReportSelection(groups),
    structuredUrl:
      report.status === "completed" ? "/structured.json" : undefined,
  };
}

function renderCard(props: ComponentProps<typeof ExperimentReportCard>) {
  return render(
    <MemoryRouter>
      <ExperimentReportCard {...props} />
    </MemoryRouter>,
  );
}

function expectStableShell(container: HTMLElement) {
  const panel = container.querySelector(
    '[data-slot="experiment-report-panel"]',
  );
  const header = container.querySelector(
    '[data-slot="experiment-report-header"]',
  );
  const toolbar = container.querySelector(
    '[data-slot="experiment-report-toolbar"]',
  );
  const selectors = container.querySelector(
    '[data-slot="experiment-report-selectors"]',
  );
  const actions = container.querySelector(
    '[data-slot="experiment-report-actions"]',
  );
  const body = container.querySelector('[data-slot="experiment-report-body"]');

  expect(panel).not.toBeNull();
  expect(header).not.toBeNull();
  expect(toolbar).not.toBeNull();
  expect(selectors).not.toBeNull();
  expect(actions).not.toBeNull();
  expect(body).not.toBeNull();
  expect(header?.nextElementSibling).toBe(body);
  expect(header?.contains(toolbar)).toBe(true);
}

afterEach(() => cleanup());

describe("ExperimentReportCard", () => {
  it.each([
    ["completed", reportProps(completedReport)],
    ["failed", reportProps(failedReport)],
    ["processing", { ...baseProps, isProcessing: true }],
    ["blocked", { ...baseProps, isBlocked: true }],
    ["no artifact", baseProps],
  ])("keeps the stable report shell for %s", (_state, props) => {
    const { container } = renderCard(props);

    expectStableShell(container);
    expect(screen.getByRole("heading", { name: "Reports" })).toBeTruthy();
    expect(screen.getByText(/Attempt 2/)).toBeTruthy();
  });

  it("keeps report actions aligned while disabling unavailable artifacts", () => {
    const { rerender } = renderCard(reportProps(completedReport));

    expect(screen.getByRole("link", { name: "Structured JSON" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Direct link" })).toBeTruthy();

    rerender(
      <MemoryRouter>
        <ExperimentReportCard {...reportProps(failedReport)} />
      </MemoryRouter>,
    );

    expect(
      screen
        .getByRole("button", { name: "Structured JSON" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Direct link" })).toBeTruthy();
    expect(screen.getByText("Report generation failed")).toBeTruthy();
  });

  it("offers retry for the latest configurable report", () => {
    const configurableReport: Report = {
      ...completedReport,
      _id: "report-quality",
      id: "report-quality",
      templateId: "quality-summary",
      reporter: {
        id: "quality-summary",
        name: "Quality Summary",
        gitHash: "abc",
        model: "gpt-5.4",
        agentId: "copilot-sdk",
        agentVersion: "1.0.0",
      },
    };

    renderCard({
      ...reportProps(configurableReport),
      onRetry: () => undefined,
    });

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
