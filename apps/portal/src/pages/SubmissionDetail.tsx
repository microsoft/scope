// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, RotateCcw } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { SubmissionStatusCard } from "@/components/SubmissionStatusCard";
import { ShortId } from "@/components/ShortId";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";

export function SubmissionDetail() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const submissionQuery = useQuery({
    queryKey: ["submission", id],
    queryFn: () => api.getSubmission(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const readiness = query.state.data?.readiness;
      return readiness === "done" || readiness === "failed" || readiness === "blocked"
        ? false
        : 5_000;
    },
  });
  const retry = useMutation({
    mutationFn: () =>
      api.retrySubmission(
        submissionQuery.data!.submissionId,
        submissionQuery.data!.submissionRunId,
      ),
    onSuccess: () => {
      toast.success("Submission processing restarted");
      void queryClient.invalidateQueries({ queryKey: ["submission", id] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Retry failed");
    },
  });

  if (submissionQuery.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading submission…</div>;
  }
  if (submissionQuery.isError || !submissionQuery.data) {
    return (
      <div className="p-6">
        <p className="text-destructive">Submission could not be loaded.</p>
      </div>
    );
  }
  const submission = submissionQuery.data;
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
            <Link to="/runs">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Runs
            </Link>
          </Button>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">Submission</h1>
            <ShortId id={submission.submissionId} label="submission ID" />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Created {formatDate(submission.createdAt)}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => retry.mutate()}
          disabled={
            retry.isPending ||
            submission.readiness === "waiting" ||
            submission.readiness === "blocked" ||
            submission.readiness === "processing"
          }
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          Retry processing
        </Button>
      </div>

      <SubmissionStatusCard submission={submission} />

      {submission.blocking.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Blocking dependencies</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {submission.blocking.map((blocking) => (
              <div
                key={`${blocking.requestId}:${blocking.runId}`}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <Link
                  to={`/runs/${blocking.requestId}`}
                  className="font-mono text-primary hover:underline"
                >
                  {blocking.requestId.slice(0, 8)}
                </Link>
                <Badge variant="destructive">{blocking.reason}</Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  {blocking.runId}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Runs</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {submission.requests.map((request) => {
            const dependency = submission.dependencyProjection.find(
              (item) =>
                item.requestId === request.requestId && item.runId === request.runId,
            );
            return (
              <Link
                key={request.requestId}
                to={`/runs/${request.requestId}`}
                className="flex items-center justify-between gap-4 py-4 hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{request.task}</span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {request.requestId} · {request.runId}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline">{request.status}</Badge>
                  <Badge
                    variant={
                      dependency?.state === "failed" || dependency?.state === "blocked"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {dependency?.state ?? "waiting"}
                  </Badge>
                </div>
              </Link>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
