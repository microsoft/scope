// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, OutcomeBadge } from "@/components/StatusBadge";
import { CliCommand } from "@/components/CliCommand";
import { buildRunGet } from "@/lib/cli/buildCommand";
import { formatDate, formatId, formatDuration, truncate } from "@/lib/utils";

export function RunPreviewPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: run, isLoading, error } = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.getRun(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      if (status === "done") return false;
      return 5_000;
    },
  });

  const closePanel = () => navigate({ pathname: "/runs", search: window.location.search });

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

  if (error || !run) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Run not found.</p>
      </DetailPanel>
    );
  }

  const state = run.run;
  const status = state?.status;
  const outcome = state?.outcome;
  const startedAt = state?.startedAt;
  const finishedAt = state?.finishedAt;
  const duration =
    startedAt && finishedAt
      ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
      : null;

  return (
    <DetailPanel
      title={<span className="truncate font-mono text-sm">{formatId(run._id)}</span>}
      subtitle={run.scenario?.task ? truncate(run.scenario.task, 80) : run.workerType}
      onClose={closePanel}
      headerActions={
        <div className="flex justify-end gap-2">
          <CliCommand command={buildRunGet(run._id)} align="end" />
          <Link to={`/runs/${run._id}`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              Open full view
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
              {status && <StatusBadge status={status} />}
              {outcome && <OutcomeBadge outcome={outcome} />}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Worker</dt>
                <dd className="mt-0.5 font-mono text-xs">{run.workerType}</dd>
              </div>
              {run.model && (
                <div>
                  <dt className="text-xs text-muted-foreground">Model</dt>
                  <dd className="mt-0.5 font-mono text-xs break-all">{run.model}</dd>
                </div>
              )}
              {run.agentVersion && (
                <div>
                  <dt className="text-xs text-muted-foreground">Version</dt>
                  <dd className="mt-0.5 font-mono text-xs">{run.agentVersion}</dd>
                </div>
              )}
              {run.maxIterations !== undefined && (
                <div>
                  <dt className="text-xs text-muted-foreground">Max Iterations</dt>
                  <dd className="mt-0.5 font-mono text-xs">{run.maxIterations}</dd>
                </div>
              )}
              {state?.attemptNumber !== undefined && (
                <div>
                  <dt className="text-xs text-muted-foreground">Attempt</dt>
                  <dd className="mt-0.5 font-mono text-xs">#{state.attemptNumber}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {state && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Stats</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Turns</dt>
                  <dd className="mt-0.5 font-mono text-xs">{state.turns?.length ?? 0}</dd>
                </div>
                {state.aiCallCount !== undefined && (
                  <div>
                    <dt className="text-xs text-muted-foreground">LLM Calls</dt>
                    <dd className="mt-0.5 font-mono text-xs">{state.aiCallCount}</dd>
                  </div>
                )}
                {duration !== null && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Duration</dt>
                    <dd className="mt-0.5 font-mono text-xs">{formatDuration(duration)}</dd>
                  </div>
                )}
                {state.tokenUsage && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Tokens</dt>
                    <dd className="mt-0.5 font-mono text-xs">
                      {state.tokenUsage.totalTokens.toLocaleString()}
                    </dd>
                  </div>
                )}
              </dl>
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
                <dd className="mt-0.5 font-mono text-xs">{formatDate(run.createdAt)}</dd>
              </div>
              {startedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Started</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(startedAt)}</dd>
                </div>
              )}
              {finishedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Finished</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(finishedAt)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {state?.error && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-destructive">Error</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">
                {state.error}
              </pre>
            </CardContent>
          </Card>
        )}
      </div>
    </DetailPanel>
  );
}
