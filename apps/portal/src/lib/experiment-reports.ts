// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Report } from "@/types";

export interface ExperimentReportGroup {
  key: string;
  label: string;
  reports: Report[];
}

export interface ExperimentReportSelection {
  group: ExperimentReportGroup;
  report: Report;
  isLatest: boolean;
}

function reportTimestamp(report: Report): number {
  const parsed = Date.parse(report.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function experimentReportTypeKey(report: Report): string {
  if (report.templateId) return `template:${report.templateId}`;
  if (report.reporter?.id) return `reporter:${report.reporter.id}`;
  return "report:untyped";
}

function reportTypeLabel(report: Report): string {
  if (report.templateId && report.reporter?.name) {
    return `${report.reporter.name} · ${report.templateId}`;
  }
  return report.reporter?.name ?? report.templateId ?? "Report";
}

export function groupExperimentReports(
  reports: Report[],
): ExperimentReportGroup[] {
  const byType = new Map<string, ExperimentReportGroup>();
  for (const report of reports) {
    const key = experimentReportTypeKey(report);
    const group = byType.get(key);
    if (group) {
      group.reports.push(report);
    } else {
      byType.set(key, {
        key,
        label: reportTypeLabel(report),
        reports: [report],
      });
    }
  }

  const groups = [...byType.values()];
  for (const group of groups) {
    group.reports.sort(
      (left, right) =>
        reportTimestamp(right) - reportTimestamp(left) ||
        right._id.localeCompare(left._id),
    );
  }
  return groups.sort(
    (left, right) =>
      reportTimestamp(right.reports[0]) - reportTimestamp(left.reports[0]) ||
      left.label.localeCompare(right.label),
  );
}

export function resolveExperimentReportSelection(
  groups: ExperimentReportGroup[],
  requestedType?: string,
  requestedReportId?: string,
): ExperimentReportSelection | undefined {
  if (groups.length === 0) return undefined;

  const reportGroup = requestedReportId
    ? groups.find((group) =>
        group.reports.some((report) => report._id === requestedReportId),
      )
    : undefined;
  const group =
    groups.find((candidate) => candidate.key === requestedType) ??
    reportGroup ??
    groups[0];
  const report =
    group.reports.find((candidate) => candidate._id === requestedReportId) ??
    group.reports[0];

  return {
    group,
    report,
    isLatest: report._id === group.reports[0]._id,
  };
}
