// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { formatDate, formatId, truncate } from "@/lib/utils";

export function ReportPreviewPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: report, isLoading, error } = useQuery({
    queryKey: ["report", id],
    queryFn: () => api.getReport(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "completed" || status === "failed") return false;
      return 5_000;
    },
  });

  const closePanel = () =>
    navigate({ pathname: "/reports", search: window.location.search });

  if (isLoading) {
    return (
      <DetailPanel title="Loading…" onClose={closePanel}>
        <div className="space-y-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-32 w-full" />
        </div>
      </DetailPanel>
    );
  }

  if (error || !report) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Report not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={<span className="truncate font-mono text-sm">{formatId(report._id)}</span>}
      subtitle={report.task ? truncate(report.task, 80) : "Report"}
      onClose={closePanel}
      headerActions={
        <div className="flex flex-wrap justify-end gap-2">
          {report.experimentId && report.experimentExecutionId ? (
            <Link
              to={`/experiments/${report.experimentId}?execution=${encodeURIComponent(report.experimentExecutionId)}&report=${encodeURIComponent(report._id)}`}
            >
              <Button variant="outline" size="sm" className="gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" /> Open experiment
              </Button>
            </Link>
          ) : report.requestId ? (
            <Link to={`/runs/${report.requestId}`}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" /> Open run
              </Button>
            </Link>
          ) : null}
          <Link to={`/reports/${report._id}`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" /> Open full view
            </Button>
          </Link>
        </div>
      }
    >
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <ReportStatusBadge status={report.status} />
              {report.templateId ? (
                <Badge variant="outline" className="font-mono text-xs">
                  {report.templateId}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">
                  {report.experimentId ? "built-in" : "default template"}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {report.reporter && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Reporter</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                {report.reporter.model && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Model</dt>
                    <dd className="mt-0.5 font-mono text-xs break-all">{report.reporter.model}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>
        )}

        {report.content && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Excerpt</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                {truncate(report.content, 400)}
              </p>
            </CardContent>
          </Card>
        )}

        {report.error && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-destructive">Error</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">
                {report.error}
              </pre>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-0.5 font-mono text-xs">{formatDate(report.createdAt)}</dd>
              </div>
              {report.updatedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(report.updatedAt)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
