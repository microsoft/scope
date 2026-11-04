// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AlertTriangle, CheckCircle2, CircleSlash2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  TaxonomyAssessment,
  TaxonomyEvaluation,
  TaxonomyRunResult,
} from "@/lib/taxonomy-result";

function AssessmentView({ assessment }: { assessment: TaxonomyAssessment }) {
  if (assessment.state === "indeterminate" || assessment.state === "inapplicable") {
    return (
      <div className="space-y-1">
        <Badge variant="warning">{assessment.state}</Badge>
        <p className="text-sm text-muted-foreground">{assessment.reason}</p>
      </div>
    );
  }
  if (!assessment.observed) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleSlash2 className="h-4 w-4" />
        Not observed
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-4 w-4" />
        Observed · {assessment.occurrences.length} occurrence
        {assessment.occurrences.length === 1 ? "" : "s"}
      </div>
      {assessment.occurrences.map((occurrence, index) => (
        <div key={index} className="rounded-md border bg-muted/20 p-2 text-xs">
          <div className="mb-1 font-medium">Occurrence {index + 1}</div>
          {occurrence.evidence.map((evidence) => (
            <div key={`${evidence.role}:${evidence.path}`} className="font-mono">
              <span className="text-muted-foreground">{evidence.role}: </span>
              {evidence.path}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EvaluationCard({ evaluation }: { evaluation: TaxonomyEvaluation }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{evaluation.element.label}</CardTitle>
            <div className="font-mono text-xs text-muted-foreground">
              {evaluation.element.id}
              {evaluation.element.category_id
                ? ` · ${evaluation.element.category_id}`
                : ""}
            </div>
          </div>
          <div className="flex gap-2">
            <Badge variant="outline">{evaluation.implementation.type}</Badge>
            <Badge variant={evaluation.status === "succeeded" ? "success" : "destructive"}>
              {evaluation.status}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {evaluation.implementation.handler && (
          <div className="text-xs text-muted-foreground">
            Handler: <span className="font-mono">{evaluation.implementation.handler}</span>
          </div>
        )}
        {evaluation.implementation.provider && (
          <div className="text-xs text-muted-foreground">
            Provider: {evaluation.implementation.provider.name}
            {evaluation.implementation.provider.version
              ? ` ${evaluation.implementation.provider.version}`
              : ""}
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          Attempts:{" "}
          {evaluation.implementation.attempts.map((attempt) => (
            <span
              key={`${attempt.attempt}:${attempt.kind}`}
              className="mr-2 font-mono"
            >
              {attempt.attempt} {attempt.kind}: {attempt.outcome}
            </span>
          ))}
        </div>
        {evaluation.status === "succeeded" && evaluation.result ? (
          <AssessmentView assessment={evaluation.result} />
        ) : (
          <div className="space-y-1 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4" />
              {evaluation.error?.code ?? "evaluation_failed"}
            </div>
            <p>{evaluation.error?.message ?? "The element evaluation failed."}</p>
            {evaluation.error?.validation_errors?.map((diagnostic, index) => (
              <div
                key={`${diagnostic.code}:${diagnostic.output_path}:${index}`}
                className="rounded-md border border-destructive/30 bg-background p-2 text-xs"
              >
                <div className="font-mono">
                  {diagnostic.code} · {diagnostic.output_path}
                </div>
                {diagnostic.role && <div>Role: {diagnostic.role}</div>}
                {diagnostic.evidence_path && (
                  <div className="font-mono">{diagnostic.evidence_path}</div>
                )}
                {diagnostic.message && <div>{diagnostic.message}</div>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function TaxonomeResultView({
  result,
  loading = false,
  error,
  readOnlyLabel,
}: {
  result?: TaxonomyRunResult;
  loading?: boolean;
  error?: string;
  readOnlyLabel?: "Historical" | "Deleted";
}) {
  if (loading) {
    return (
      <div className="space-y-3" aria-label="Loading Taxonome result">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4" />
          Taxonome result unavailable
        </div>
        {error}
      </div>
    );
  }
  if (!result) return null;
  const taxonomy = result.results[0]?.taxonomy;
  return (
    <div className="space-y-4">
      <section className="rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-medium">Taxonome result</h3>
            <p className="text-sm text-muted-foreground">
              Run {result.run.id} · {result.run.scenario.label} · {result.run.profile.label}
            </p>
          </div>
          {readOnlyLabel && <Badge variant="outline">{readOnlyLabel}</Badge>}
        </div>
        {taxonomy && (
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <div><span className="text-muted-foreground">Taxonomy </span>{taxonomy.id}</div>
            <div><span className="text-muted-foreground">Version </span>{taxonomy.version}</div>
            <div className="truncate font-mono" title={taxonomy.digest}>
              <span className="text-muted-foreground">Digest </span>{taxonomy.digest}
            </div>
          </div>
        )}
      </section>
      <div className="grid gap-3 xl:grid-cols-2">
        {result.results.map((evaluation) => (
          <EvaluationCard
            key={`${evaluation.element.id}:${evaluation.input.sha256 ?? ""}`}
            evaluation={evaluation}
          />
        ))}
      </div>
    </div>
  );
}
