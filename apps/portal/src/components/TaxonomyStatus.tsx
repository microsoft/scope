// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TaxonomyHandlerSummary } from "@/types";

export function TaxonomyStatus({
  summary,
}: {
  summary?: TaxonomyHandlerSummary;
}) {
  if (!summary) {
    return (
      <span className="text-xs text-muted-foreground" aria-label="Taxonomy unavailable">
        —
      </span>
    );
  }

  const view =
    summary.status === "queued"
      ? { label: "Queued", variant: "purple" as const }
      : summary.status === "processing"
        ? { label: "Processing", variant: "info" as const }
        : summary.status === "failed"
          ? { label: "Failed", variant: "destructive" as const }
          : summary.resultAvailable
            ? { label: "Completed", variant: "success" as const }
            : { label: "Result unavailable", variant: "warning" as const };
  const badge = (
    <Badge
      variant={view.variant}
      className={summary.status === "processing" ? "animate-shimmer" : undefined}
    >
      {view.label}
    </Badge>
  );
  if (!summary.error && !summary.updatedAt) return badge;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{badge}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-xs">
          {summary.error && <div>{summary.error}</div>}
          {summary.updatedAt && (
            <div className="text-muted-foreground">
              Updated {new Date(summary.updatedAt).toLocaleString()}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
