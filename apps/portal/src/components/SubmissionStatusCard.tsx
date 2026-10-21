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

export function SubmissionStatusCard({
  submission,
}: {
  submission: Submission;
}) {
  const ready = submission.dependencyProjection.filter(
    (dependency) => dependency.state === "ready",
  ).length;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Processing</CardTitle>
        <Badge variant={readinessVariant[submission.readiness]}>
          {submission.readiness}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <div className="text-muted-foreground">Attempt</div>
          <div className="font-medium">{submission.attemptNumber}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Observations ready</div>
          <div className="font-medium">
            {ready}/{submission.requests.length}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Blocking runs</div>
          <div className="font-medium">{submission.blocking.length}</div>
        </div>
      </CardContent>
    </Card>
  );
}
