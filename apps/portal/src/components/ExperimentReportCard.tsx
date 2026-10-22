// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Download, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ExperimentReportGroup,
  ExperimentReportSelection,
} from "@/lib/experiment-reports";
import { formatDate } from "@/lib/utils";

interface ExperimentReportCardProps {
  experimentId: string;
  experimentExecutionId: string;
  attemptNumber?: number;
  groups: ExperimentReportGroup[];
  selection?: ExperimentReportSelection;
  structuredUrl?: string;
  isLoading?: boolean;
  error?: string;
  isProcessing?: boolean;
  isBlocked?: boolean;
  onReportTypeChange?: (typeKey: string) => void;
  onReportVersionChange?: (reportId: string) => void;
  onRetry?: () => void;
}

export function ExperimentReportCard({
  experimentId,
  experimentExecutionId,
  attemptNumber,
  groups,
  selection,
  structuredUrl,
  isLoading,
  error,
  isProcessing,
  isBlocked,
  onReportTypeChange,
  onReportVersionChange,
  onRetry,
}: ExperimentReportCardProps) {
  const report = selection?.report;
  const emptyStateClassName =
    "flex min-h-44 flex-col items-start justify-center gap-3 rounded-lg border border-dashed bg-muted/20 p-6";

  return (
    <Card data-slot="experiment-report-panel">
      <CardHeader
        data-slot="experiment-report-header"
        className="space-y-4"
      >
        <div className="min-h-12">
          <CardTitle className="text-base">Reports</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Attempt {attemptNumber ?? "…"} ·{" "}
            <span className="font-mono">{experimentExecutionId}</span>
          </p>
        </div>
        <div
          data-slot="experiment-report-toolbar"
          className="grid min-h-16 gap-3 border-t pt-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end"
        >
          <div
            data-slot="experiment-report-selectors"
            className="flex flex-wrap items-end gap-2"
          >
            {groups.length > 1 && selection && (
              <div className="space-y-1">
                <label className="block text-xs font-medium text-muted-foreground">
                  Report type
                </label>
                <Select
                  value={selection.group.key}
                  onValueChange={onReportTypeChange}
                >
                  <SelectTrigger
                    aria-label="Report type"
                    className="w-[220px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {groups.map((group) => (
                      <SelectItem key={group.key} value={group.key}>
                        {group.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {selection && selection.group.reports.length > 1 && (
              <div className="space-y-1">
                <label className="block text-xs font-medium text-muted-foreground">
                  Version
                </label>
                <Select
                  value={report?._id}
                  onValueChange={onReportVersionChange}
                >
                  <SelectTrigger
                    aria-label="Report version"
                    className="w-[220px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {selection.group.reports.map((version, index) => (
                      <SelectItem key={version._id} value={version._id}>
                        Version {selection.group.reports.length - index} ·{" "}
                        {index === 0 ? "Latest" : "Historical"} ·{" "}
                        {formatDate(version.createdAt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div
            data-slot="experiment-report-actions"
            className="flex min-h-9 flex-wrap items-center gap-2 lg:justify-end"
          >
            {report ? (
              <>
                <Badge variant={selection?.isLatest ? "default" : "secondary"}>
                  {selection?.isLatest ? "Latest" : "Historical"}
                </Badge>
                <ReportStatusBadge status={report.status} />
                {structuredUrl ? (
                  <Button variant="outline" size="sm" asChild>
                    <a href={structuredUrl} download>
                      <Download className="mr-1 h-3.5 w-3.5" />
                      Structured JSON
                    </a>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled
                    title="Structured artifact unavailable"
                  >
                    <Download className="mr-1 h-3.5 w-3.5" />
                    Structured JSON
                  </Button>
                )}
                <Button variant="outline" size="sm" asChild>
                  <Link
                    to={`/reports/${report._id}?experimentId=${encodeURIComponent(experimentId)}&experimentExecutionId=${encodeURIComponent(experimentExecutionId)}`}
                  >
                    <ExternalLink className="mr-1 h-3.5 w-3.5" />
                    Direct link
                  </Link>
                </Button>
              </>
            ) : isLoading ? (
              <Badge variant="outline">Loading</Badge>
            ) : error ? (
              <Badge variant="destructive">Unavailable</Badge>
            ) : isBlocked ? (
              <Badge variant="destructive">Blocked</Badge>
            ) : isProcessing ? (
              <Badge variant="secondary">Processing</Badge>
            ) : (
              <Badge variant="outline">No report</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent
        data-slot="experiment-report-body"
        className="border-t pt-6"
      >
        {isLoading ? (
          <div className={emptyStateClassName}>
            <p className="font-medium">Loading report</p>
            <p className="text-sm text-muted-foreground">
              The selected report version is being retrieved.
            </p>
          </div>
        ) : error ? (
          <div className={emptyStateClassName}>
            <p className="font-medium">Report unavailable</p>
            <p className="text-sm text-destructive">{error}</p>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        ) : report?.status === "failed" ? (
          <div className={emptyStateClassName}>
            <p className="font-medium">Report generation failed</p>
            <p className="text-sm text-destructive">
              {report.error ?? "Readout generation failed."}
            </p>
          </div>
        ) : report?.content ? (
          <div className="prose min-h-44 max-w-none dark:prose-invert">
            <MarkdownRenderer githubAlerts>{report.content}</MarkdownRenderer>
          </div>
        ) : (
          <div className={emptyStateClassName}>
            <p className="font-medium">
              {isBlocked
                ? "Report blocked"
                : isProcessing
                  ? "Report processing"
                  : "No report available"}
            </p>
            <p className="text-sm text-muted-foreground">
              {isBlocked
                ? "Required processing must recover before a report can be published."
                : isProcessing
                  ? "The report is being generated."
                  : "No built-in report is available for this execution."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
