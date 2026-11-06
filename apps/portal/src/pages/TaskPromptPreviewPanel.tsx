// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, List } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatId, truncate } from "@/lib/utils";

export function TaskPromptPreviewPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: taskPrompt, isLoading, error } = useQuery({
    queryKey: ["task-prompt", id],
    queryFn: () => api.getTaskPrompt(id!),
    enabled: !!id,
  });

  const closePanel = () =>
    navigate({ pathname: "/task-prompts", search: window.location.search });

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

  if (error || !taskPrompt) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Task prompt not found.</p>
      </DetailPanel>
    );
  }

  const extracted = (taskPrompt.features?.length ?? 0) > 0;
  const detected = taskPrompt.features?.filter((f) => f.detected).length ?? 0;

  return (
    <DetailPanel
      title={<span className="truncate font-mono text-sm">{formatId(taskPrompt._id)}</span>}
      subtitle={truncate(taskPrompt.text ?? "", 80)}
      onClose={closePanel}
      headerActions={
        <div className="flex flex-wrap justify-end gap-2">
          <Link to={`/runs?taskPromptId=${encodeURIComponent(taskPrompt._id)}`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <List className="h-3.5 w-3.5" /> View runs
            </Button>
          </Link>
          <Link to={`/task-prompts/${taskPrompt._id}`}>
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
            <CardTitle className="text-sm">Prompt text</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
              {taskPrompt.text !== undefined
                ? truncate(taskPrompt.text, 1200)
                : "(Stored in blob storage — open the full view to load the body.)"}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Features</CardTitle>
          </CardHeader>
          <CardContent>
            {!extracted ? (
              <p className="text-xs text-muted-foreground">Not extracted.</p>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {detected} detected
                  </Badge>
                  {taskPrompt.featuresExtractedAt && (
                    <span className="text-xs text-muted-foreground">
                      Extracted {formatDate(taskPrompt.featuresExtractedAt)}
                    </span>
                  )}
                </div>
                {detected > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {taskPrompt.features
                      ?.filter((f) => f.detected)
                      .map((f) => (
                        <Badge
                          key={f.featureId}
                          variant="default"
                          className="font-mono text-xs"
                        >
                          {f.featureId}
                        </Badge>
                      ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No features detected.</p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-0.5 font-mono text-xs">{formatDate(taskPrompt.createdAt)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
