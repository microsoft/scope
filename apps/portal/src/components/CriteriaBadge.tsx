// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { criterionResultStyle, type CriterionResultState } from "@/lib/criteria-result";
import type { CriterionKind, CriterionSubject } from "@/types";

const PROMPT_LEN = 320;

interface CriteriaBadgeProps {
  criterionId: string;
  result?: CriterionResultState;
  evaluated?: boolean;
  link?: boolean;
  showStateLabel?: boolean;
  className?: string;
  kind?: CriterionKind;
  /**
   * Preloaded criterion prompt for the hover preview. When omitted, the prompt
   * is fetched lazily the first time the tooltip opens (so dense lists don't
   * fan out one request per badge).
   */
  prompt?: string;
}

export function CriteriaBadge({
  criterionId,
  result,
  evaluated = false,
  link = true,
  showStateLabel = false,
  className,
  kind,
  prompt,
}: CriteriaBadgeProps) {
  const kindLabel = kind === "observation" ? "Obs" : kind === "gate" ? "Gate" : undefined;
  const [open, setOpen] = useState(false);

  const { data: fetched, isLoading } = useQuery({
    queryKey: ["criterion", criterionId],
    queryFn: () => api.getCriterion(criterionId),
    enabled: open && prompt === undefined,
    staleTime: 5 * 60 * 1000,
  });

  const promptText = prompt ?? fetched?.prompt;
  const content = !evaluated ? (
    <span className="inline-flex items-center gap-1">
      <Badge variant="secondary" className={cn("font-mono text-xs", className)}>
        {criterionId}
      </Badge>
      {kindLabel && <CriteriaKindBadge kind={kind} />}
    </span>
  ) : (() => {
    const { colorClass, Icon, label } = criterionResultStyle(result);
    return (
      <span className="inline-flex items-center gap-1">
        <Badge variant="outline" className={cn("font-mono text-xs", colorClass, className)}>
          <Icon className="h-3 w-3 shrink-0 mr-1" />
          {showStateLabel ? `${criterionId}: ${label}` : criterionId}
        </Badge>
        {kindLabel && <CriteriaKindBadge kind={kind} />}
      </span>
    );
  })();

  const trigger = link ? (
    <Link
      to={`/criteria/${criterionId}`}
      className="inline-flex"
      onClick={(e) => e.stopPropagation()}
    >
      {content}
    </Link>
  ) : (
    <span className="inline-flex">{content}</span>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          <div className="space-y-1.5 text-xs">
            <div className="font-mono font-medium">{criterionId}</div>
            {isLoading && promptText === undefined ? (
              <Skeleton className="h-10 w-52" />
            ) : promptText !== undefined ? (
              <p className="max-h-40 overflow-hidden whitespace-pre-wrap break-words text-muted-foreground">
                {promptText.length > PROMPT_LEN ? `${promptText.slice(0, PROMPT_LEN)}…` : promptText}
              </p>
            ) : null}
            <div className="text-muted-foreground">
              {link ? "Click to open details →" : "Open the criterion detail page for more."}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function CriteriaKindBadge({ kind, className }: { kind?: CriterionKind; className?: string }) {
  const normalized = kind ?? "gate";
  return (
    <Badge
      variant={normalized === "observation" ? "outline" : "secondary"}
      className={cn(
        "text-[10px] uppercase tracking-wide",
        normalized === "observation" && "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        className,
      )}
    >
      {normalized === "observation" ? "Observation" : "Gate"}
    </Badge>
  );
}

/**
 * Small badge showing an observation's evaluation subject (#1156):
 * "Whole run" (subject:"run") vs "Per iteration" (subject:"iteration").
 * Defaults to "run" when unset (the observation default). Intended for
 * observation criteria; subject is inert for gates.
 */
export function CriteriaSubjectBadge({ subject, className }: { subject?: CriterionSubject; className?: string }) {
  const normalized = subject ?? "run";
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] uppercase tracking-wide",
        normalized === "run"
          ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        className,
      )}
      title={normalized === "run" ? "Evaluated once across the whole run" : "Evaluated on each iteration in isolation"}
    >
      {normalized === "run" ? "Whole run" : "Per iteration"}
    </Badge>
  );
}
