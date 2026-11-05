// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExperimentView } from "@/lib/experiments";

export function ExperimentStatusCard({
  experiment,
}: {
  experiment: ExperimentView;
}) {
  const readiness = experiment.readiness ?? "unknown";
  const variant =
    readiness === "failed" || readiness === "blocked"
      ? "destructive"
      : readiness === "processing" || readiness === "done"
        ? "default"
        : readiness === "ready"
          ? "outline"
          : "secondary";
  const handlers = Object.values(experiment.execution.handlerProgress);
  const completedHandlers = handlers.filter(
    (handler) =>
      handler &&
      typeof handler === "object" &&
      "status" in handler &&
      handler.status === "done",
  ).length;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Processing</CardTitle>
        <Badge variant={variant}>{readiness}</Badge>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <div className="text-muted-foreground">Attempt</div>
          <div className="font-medium">
            {experiment.execution.attemptNumber}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Handlers complete</div>
          <div className="font-medium">
            {completedHandlers}/{handlers.length}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Blocking runs</div>
          <div className="font-medium">{experiment.blocking.length}</div>
        </div>
      </CardContent>
    </Card>
  );
}
