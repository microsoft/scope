// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { promptTypeLabel } from "@/lib/gates";
import { cn, formatDate, formatId, truncate } from "@/lib/utils";
import type { TaskPrompt } from "@/types";

const SNIPPET_LEN = 280;

interface TaskPromptBadgeProps {
  /** Content-addressed task prompt id (used for the link target and lazy fetch). */
  taskPromptId?: string | null;
  /**
   * Preloaded prompt to render the hover preview without a network round-trip.
   * When omitted, the prompt is fetched lazily the first time the tooltip opens.
   */
  prompt?: TaskPrompt;
  /** Full text to show when a legacy run has no task prompt reference. */
  fallbackText?: string;
  /** Custom trigger content. Defaults to a `<type label> · <short id>` badge. */
  children?: ReactNode;
  /** When true (default) the trigger links to the task prompt detail page. */
  link?: boolean;
  /** Class applied to the trigger wrapper (Link/span). */
  className?: string;
}

/**
 * Hover-to-preview + click-to-navigate badge for a task prompt of **any** type.
 *
 * The component is intentionally type-agnostic: gate prompts
 * (`select`/`build`/`test`/`run`/`deploy`), `agents.md`, and legacy untyped
 * prompts all render with the same hover preview and the same
 * `/task-prompts/:id` navigation. The only type-dependent bit is the human
 * label, which comes from {@link promptTypeLabel}.
 *
 * To avoid request fan-out on dense screens, the prompt is only fetched when
 * the tooltip actually opens (and never when a preloaded `prompt` is supplied).
 */
export function TaskPromptBadge({
  taskPromptId,
  prompt,
  fallbackText,
  children,
  link = true,
  className,
}: TaskPromptBadgeProps) {
  const [open, setOpen] = useState(false);

  const { data: fetched, isLoading: loadingPrompt } = useQuery({
    queryKey: ["task-prompt", taskPromptId],
    queryFn: () => api.getTaskPrompt(taskPromptId as string),
    enabled: open && !prompt && !!taskPromptId,
    staleTime: 5 * 60 * 1000,
  });

  const resolved = prompt ?? fetched;

  // Blob-backed prompts omit `text`; fetch the body for the snippet on open.
  const needsContent = open && !!resolved && resolved.text === undefined && !!taskPromptId;
  const { data: content } = useQuery({
    queryKey: ["task-prompt-content", taskPromptId],
    queryFn: () => api.getTaskPromptContent(taskPromptId as string),
    enabled: needsContent,
    staleTime: 5 * 60 * 1000,
  });

  const typeLabel = promptTypeLabel(resolved?.type);
  const snippet = resolved?.text ?? content?.text;
  const detectedFeatures = resolved?.features?.filter((f) => f.detected) ?? [];

  // Legacy runs can still preview their inline task without a prompt reference.
  if (!taskPromptId) {
    if (fallbackText) {
      return (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className={cn("inline-flex max-w-full", className)}>
                {children ?? fallbackText}
              </span>
            </TooltipTrigger>
            <TooltipPrimitive.Portal>
              <TooltipContent
                side="top"
                collisionPadding={8}
                className="max-w-sm max-h-[var(--radix-tooltip-content-available-height)] overflow-y-auto whitespace-pre-wrap break-words text-xs"
              >
                {fallbackText}
              </TooltipContent>
            </TooltipPrimitive.Portal>
          </Tooltip>
        </TooltipProvider>
      );
    }
    return children ? (
      <span className={cn("inline-flex max-w-full", className)}>{children}</span>
    ) : null;
  }

  const trigger = children ?? (
    <Badge variant="secondary" className="font-mono text-xs">
      {typeLabel} · {formatId(taskPromptId)}
    </Badge>
  );

  const wrapper = link ? (
    <Link
      to={`/task-prompts/${encodeURIComponent(taskPromptId)}`}
      className={cn("inline-flex max-w-full", className)}
      onClick={(e) => e.stopPropagation()}
    >
      {trigger}
    </Link>
  ) : (
    <span className={cn("inline-flex max-w-full", className)}>{trigger}</span>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>{wrapper}</TooltipTrigger>
        <TooltipPrimitive.Portal>
          <TooltipContent side="top" collisionPadding={8} className="max-w-sm">
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium">{typeLabel}</span>
                <span className="font-mono text-muted-foreground">{formatId(taskPromptId)}</span>
              </div>
              {loadingPrompt && !resolved ? (
                <Skeleton className="h-10 w-52" />
              ) : (
                <>
                  {snippet !== undefined ? (
                    <p className="max-h-40 overflow-hidden whitespace-pre-wrap break-words text-muted-foreground">
                      {truncate(snippet, SNIPPET_LEN)}
                    </p>
                  ) : resolved?.text === undefined ? (
                    <p className="italic text-muted-foreground">Open to view the full body.</p>
                  ) : null}
                  {detectedFeatures.length > 0 && (
                    <div className="space-y-1">
                      <div className="font-medium">Detected features</div>
                      <div className="flex flex-wrap gap-1">
                        {detectedFeatures.map((f) => (
                          <Badge
                            key={f.featureId}
                            variant="secondary"
                            className="gap-1 font-mono text-[10px]"
                          >
                            <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                            {f.featureId}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {resolved?.createdAt && (
                    <div className="text-muted-foreground">Created {formatDate(resolved.createdAt)}</div>
                  )}
                </>
              )}
              {link && (
                <Button
                  asChild
                  size="sm"
                  variant="secondary"
                  className="mt-0.5 h-7 w-full justify-center gap-1"
                >
                  <Link
                    to={`/task-prompts/${encodeURIComponent(taskPromptId)}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    Open details
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
            </div>
          </TooltipContent>
        </TooltipPrimitive.Portal>
      </Tooltip>
    </TooltipProvider>
  );
}
