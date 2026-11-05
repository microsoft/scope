// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import type { SharedRun, SharedRunArtifact } from "shared/run-sharing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDuration } from "@/lib/utils";

export function SharedText({ children }: { children: string }) {
  return <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-4 text-sm">{children}</pre>;
}

export function SharedRunUnavailable({ temporary = false, onRetry }: { temporary?: boolean; onRetry?: () => void }) {
  return <div role="alert" className="mx-auto max-w-md rounded-lg border p-8 text-center">
    <h1 className="text-lg font-semibold">{temporary ? "Unable to load shared run" : "Shared run is unavailable"}</h1>
    <p className="mt-2 text-sm text-muted-foreground">{temporary
      ? "Please try again. No sign-in is needed to view a valid shared link."
      : "This link may be invalid, expired, revoked, or no longer available."}</p>
    {temporary && onRetry && <Button className="mt-4" variant="outline" onClick={onRetry}>Retry</Button>}
  </div>;
}

interface SharedRunViewProps {
  data: SharedRun;
  logs?: ReactNode;
  reports?: ReactNode;
  artifactActions?: (artifact: SharedRunArtifact) => ReactNode;
}

export function SharedRunView({ data, logs, reports, artifactActions }: SharedRunViewProps) {
  const { run, content } = data;
  const finalResults = new Map<string, boolean | undefined>();
  const finalTurns = new Map<string, SharedRun["run"]["turns"][number]>();
  for (const turn of run.turns) {
    finalTurns.set(turn.gate ?? "select", turn);
  }
  for (const turn of finalTurns.values()) {
    for (const result of turn.criteriaResults) {
      finalResults.set(`${turn.gate ?? "select"}:${result.criterionId}`, result.evaluated ? result.passed : undefined);
    }
  }
  const evaluated = [...finalResults.values()].filter((result) => result !== undefined);
  const passed = evaluated.filter(Boolean).length;
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Shared run · Read-only</p>
          <p className="mt-1 text-muted-foreground">
            Only the sections selected by the publisher are available. This link grants no access to other Scope data.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-full">
          <h1 className="break-words text-2xl font-semibold tracking-tight">{data.label}</h1>
          <p className="mt-1 break-words text-sm text-muted-foreground">Attempt {run.attemptNumber} · {run.workerType}{run.model ? ` · ${run.model}` : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{run.status}</Badge>
          {run.outcome && <Badge variant={run.outcome === "succeeded" ? "success" : "secondary"}>{run.outcome}</Badge>}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Evaluation results</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{evaluated.length ? `${passed} / ${evaluated.length} passed` : "Not evaluated"}</CardContent>
        </Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Iterations</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{run.turns.length}</CardContent>
        </Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Duration</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{run.durationMs !== undefined ? formatDuration(run.durationMs) : run.status === "processing" ? "In progress" : "Unavailable"}</CardContent>
        </Card>
      </div>
      {data.expiresAt && <p className="text-xs text-muted-foreground">Link expires {new Date(data.expiresAt).toLocaleString()}.</p>}
      <Tabs defaultValue="results" className="space-y-4">
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="results">Results</TabsTrigger>
            {content.prompts && <TabsTrigger value="prompts">Prompts</TabsTrigger>}
            {content.conversations && <TabsTrigger value="conversations">Conversations</TabsTrigger>}
            {content.logs && <TabsTrigger value="logs">Logs</TabsTrigger>}
            {content.reports && <TabsTrigger value="reports">Reports</TabsTrigger>}
            {data.artifacts.length > 0 && <TabsTrigger value="artifacts">Artifacts</TabsTrigger>}
          </TabsList>
        </div>
        <TabsContent value="results" className="space-y-4">
          {content.evaluationDetails && run.error && <div role="alert" className="rounded-md border border-destructive/40 p-4 text-destructive">{run.error}</div>}
          {content.evaluationDetails && run.result && <SharedText>{run.result}</SharedText>}
          {run.turns.length === 0 && <p className="py-8 text-sm text-muted-foreground">No evaluation results yet.</p>}
          {run.turns.map((turn) => (
            <Card key={`${turn.gate ?? "select"}-${turn.iteration}`}>
              <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base">
                Iteration {turn.iteration}{turn.gate ? ` · ${turn.gate}` : ""}
                <Badge variant={turn.passed ? "success" : "secondary"}>{turn.passed ? "Passed" : "Not passed"}</Badge>
              </CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {turn.criteriaResults.map((result, index) => (
                  <div key={`${result.criterionId}-${index}`} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3 text-sm">
                      <span className="min-w-0 break-words font-medium">{result.criterionId}</span>
                      <Badge variant={!result.evaluated ? "outline" : result.passed ? "success" : "destructive"}>
                        {!result.evaluated ? "Not evaluated" : result.passed ? "Passed" : "Failed"}
                      </Badge>
                    </div>
                    {content.evaluationDetails && result.feedback && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{result.feedback}</p>}
                  </div>
                ))}
                {content.evaluationDetails && turn.judgeFeedback && <SharedText>{turn.judgeFeedback}</SharedText>}
                <p className="text-xs text-muted-foreground">{new Date(turn.timestamp).toLocaleString()}</p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
        {content.prompts && <TabsContent value="prompts" className="space-y-4">
          {data.prompts?.map((prompt, index) => <Card key={`${prompt.label}-${index}`}>
            <CardHeader><CardTitle className="text-base">{prompt.label}</CardTitle></CardHeader>
            <CardContent>{prompt.text === null ? <p role="status" className="text-sm text-muted-foreground">This prompt is no longer available.</p> : <SharedText>{prompt.text}</SharedText>}</CardContent>
          </Card>)}
        </TabsContent>}
        {content.conversations && <TabsContent value="conversations" className="space-y-4">
          {run.turns.length === 0 && <p className="text-sm text-muted-foreground">No conversation turns yet.</p>}
          {run.turns.map((turn) => <Card key={`${turn.gate ?? "select"}-${turn.iteration}`}>
            <CardHeader><CardTitle className="text-base">Iteration {turn.iteration}{turn.gate ? ` · ${turn.gate}` : ""}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {turn.codingAgentResponse ? <SharedText>{turn.codingAgentResponse}</SharedText> : <p className="text-sm text-muted-foreground">No agent response recorded.</p>}
              {content.prompts && content.evaluationDetails && turn.toolCalls?.map((call, index) => (
                <details key={index} className="rounded-md border p-3">
                  <summary className="cursor-pointer text-sm font-medium">{call.name}</summary>
                  <SharedText>{JSON.stringify({ arguments: call.arguments, response: call.response }, null, 2)}</SharedText>
                </details>
              ))}
            </CardContent>
          </Card>)}
        </TabsContent>}
        {content.logs && <TabsContent value="logs">{logs}</TabsContent>}
        {content.reports && <TabsContent value="reports">{reports}</TabsContent>}
        {data.artifacts.length > 0 && <TabsContent value="artifacts">
          <Card><CardHeader><CardTitle className="text-base">Shared artifacts</CardTitle>
            <p className="text-sm text-muted-foreground">Raw files may contain sensitive content. Downloads are limited to 128 MiB each.</p>
          </CardHeader><CardContent className="divide-y">
            {data.artifacts.map((artifact) => <div key={artifact.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div><p className="text-sm font-medium">{artifact.label}</p><p className="text-xs text-muted-foreground">{artifact.contentType}</p></div>
              {artifactActions?.(artifact)}
            </div>)}
          </CardContent></Card>
        </TabsContent>}
      </Tabs>
    </div>
  );
}
