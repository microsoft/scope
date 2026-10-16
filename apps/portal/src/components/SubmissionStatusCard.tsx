// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Submission } from "@/types";

const readinessVariant: Record<
  Submission["readiness"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  waiting: "secondary",
  ready: "outline",
  blocked: "destructive",
  processing: "default",
  done: "default",
  failed: "destructive",
};

const readinessLabel: Record<Submission["readiness"], string> = {
  waiting: "Waiting on dependencies",
  ready: "Ready to generate",
  blocked: "Generation blocked",
  processing: "Generating report",
  done: "Report ready",
  failed: "Generation failed",
};

export function submissionHandlerLabel(handlerId: string): string {
  return handlerId
    .replace(/^pp-/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function SubmissionStatusCard({
  submission,
}: {
  submission: Submission;
}) {
  const ready = submission.dependencyProjection.filter(
    (dependency) => dependency.state === "ready",
  ).length;
  const dependencyProgress = Array.from(
    submission.dependencyProjection.reduce(
      (progress, dependency) => {
        const current = progress.get(dependency.handlerId) ?? {
          ready: 0,
          total: 0,
        };
        current.total += 1;
        if (dependency.state === "ready") current.ready += 1;
        progress.set(dependency.handlerId, current);
        return progress;
      },
      new Map<string, { ready: number; total: number }>(),
    ),
  );
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Report generation</CardTitle>
        <Badge variant={readinessVariant[submission.readiness]}>
          {readinessLabel[submission.readiness]}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <div className="text-muted-foreground">Attempt</div>
          <div className="font-medium">{submission.attemptNumber}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Dependencies ready</div>
          <div className="font-medium">
            {ready}/{submission.dependencyProjection.length}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Blocking runs</div>
          <div className="font-medium">{submission.blocking.length}</div>
        </div>
        {dependencyProgress.length > 0 && (
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            {dependencyProgress.map(([handlerId, progress]) => (
              <Badge key={handlerId} variant="outline">
                {submissionHandlerLabel(handlerId)} {progress.ready}/{progress.total}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
