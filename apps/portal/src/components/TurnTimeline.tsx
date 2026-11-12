// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Download, CheckCircle2, XCircle, AlertCircle, MinusCircle, ChevronDown, ChevronRight, FileText, Video } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/utils";
import { formatSnapshotBytes } from "@/lib/workspace-size";
import type { ConversationTurn } from "@/types";
import { useState } from "react";

interface TurnTimelineProps {
  turns: ConversationTurn[];
  runId: string;
  /** If provided, uses per-run URLs for a specific historical attempt */
  attemptRunId?: string;
}

export function TurnTimeline({ turns, runId, attemptRunId }: TurnTimelineProps) {
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(
    // Expand last turn by default
    new Set(turns.length > 0 ? [turns[turns.length - 1].iteration] : [])
  );

  const toggleTurn = (iteration: number) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(iteration)) next.delete(iteration);
      else next.add(iteration);
      return next;
    });
  };

  if (turns.length === 0) {
    return <div className="text-sm text-muted-foreground italic py-4">No turns recorded yet.</div>;
  }

  return (
    <div className="space-y-3">
      {turns.map((turn) => {
        const isExpanded = expandedTurns.has(turn.iteration);
        return (
          <Card key={turn.iteration} className={cn(turn.passed && "border-emerald-200 dark:border-emerald-800")}>
            {/* Turn header — always visible, clickable */}
            <CardHeader
              className="cursor-pointer py-3 px-4"
              onClick={() => toggleTurn(turn.iteration)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <CardTitle className="text-base">
                    Iteration {turn.iteration}
                  </CardTitle>
                  {turn.passed ? (
                    <Badge variant="success" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Passed
                    </Badge>
                  ) : (
                    <Badge variant="warning" className="gap-1">
                      <AlertCircle className="h-3 w-3" /> Incomplete
                    </Badge>
                  )}

                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {turn.durationMs != null && (
                    <span className="font-mono" title={`${turn.durationMs.toLocaleString()}ms`}>
                      {formatDuration(turn.durationMs)}
                    </span>
                  )}
                  {new Date(turn.timestamp).toLocaleString()}
                  {turn.tokenUsage && (
                    <span className="font-mono">
                      {turn.tokenUsage.promptTokens.toLocaleString()}↑ · {turn.tokenUsage.completionTokens.toLocaleString()}↓
                    </span>
                  )}
                  {turn.aiCallCount !== undefined && (
                    <span className="font-mono" title="LLM completion calls">
                      {turn.aiCallCount} LLM calls
                    </span>
                  )}
                  {/* Workspace snapshot size — legacy/imported turns have none recorded */}
                  {turn.snapshotUrl && (
                    <span
                      className="font-mono"
                      title={turn.workspaceSizeBytes != null
                        ? `${turn.workspaceSizeBytes.toLocaleString()} bytes (compressed workspace snapshot)`
                        : "Workspace snapshot size was not recorded for this iteration"}
                    >
                      {turn.workspaceSizeBytes != null ? formatSnapshotBytes(turn.workspaceSizeBytes) : "size unavailable"}
                    </span>
                  )}
                  {turn.snapshotUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(attemptRunId ? api.runSnapshotUrl(runId, attemptRunId, turn.iteration) : api.snapshotUrl(runId, turn.iteration), "_blank");
                      }}
                    >
                      <Download className="h-3 w-3" />
                      Snapshot
                    </Button>
                  )}
                  {turn.harUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(attemptRunId ? api.runHarUrl(runId, attemptRunId, turn.iteration) : api.harUrl(runId, turn.iteration), "_blank");
                      }}
                    >
                      <FileText className="h-3 w-3" />
                      HAR
                    </Button>
                  )}
                  {turn.atifUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(api.atifUrl(runId, turn.iteration), "_blank");
                      }}
                    >
                      <Download className="h-3 w-3" />
                      ATIF
                    </Button>
                  )}
                  {turn.videoUrls && turn.videoUrls.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(attemptRunId ? api.runVideoUrl(runId, attemptRunId, turn.iteration) : api.videoUrl(runId, turn.iteration), "_blank");
                      }}
                    >
                      <Video className="h-3 w-3" />
                      Video
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>

            {/* Expanded content */}
            {isExpanded && (
              <CardContent className="pt-0 px-4 pb-4 space-y-4">
                {/* Criteria results */}
                {turn.criteriaResults && turn.criteriaResults.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2">Criteria Results</h4>
                    <div className="space-y-2">
                      {turn.criteriaResults.map((cr) => (
                        <div
                          key={cr.criterionId}
                          className="flex items-start gap-2 text-sm"
                        >
                          {!cr.evaluated ? (
                            <MinusCircle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                          ) : cr.passed ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                          )}
                          <div>
                            <span className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
                              {cr.criterionId}
                            </span>
                            {cr.feedback && (
                              <p className="text-muted-foreground mt-1">{cr.feedback}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <Separator />

                {/* Coding agent response */}
                <div>
                  <h4 className="text-sm font-medium mb-1">Coding Agent Response</h4>
                  {turn.codingAgentResponse ? (
                    <div className="prose prose-sm dark:prose-invert max-w-none bg-muted/50 rounded-md p-3 max-h-64 overflow-y-auto">
                      <MarkdownRenderer>{turn.codingAgentResponse}</MarkdownRenderer>
                    </div>
                  ) : (
                    <p className="text-xs italic text-muted-foreground">
                      No assistant response captured — see raw chat / HAR for the full transcript.
                    </p>
                  )}
                </div>

                <Separator />

                {/* Judge feedback */}
                <div>
                  <h4 className="text-sm font-medium mb-1">Judge Feedback</h4>
                  <div className="prose prose-sm dark:prose-invert max-w-none bg-muted/50 rounded-md p-3 max-h-64 overflow-y-auto">
                    <MarkdownRenderer>{turn.judgeFeedback}</MarkdownRenderer>
                  </div>
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
