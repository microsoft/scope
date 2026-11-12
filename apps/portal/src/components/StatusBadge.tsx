// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { serverNow } from "@/lib/serverClock";
import { shouldPulse } from "@/lib/status-badge";
import type { RunStatus, RunOutcome, RunState } from "@/types";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "purple";

export type StatusBadgeStatus =
  | RunStatus
  | "completed"
  | "failed"
  | "cancelled"
  | "deleted"
  | "missing";

const statusConfig: Record<StatusBadgeStatus, { label: string; variant: BadgeVariant }> = {
  pending: { label: "Pending", variant: "secondary" },
  queued: { label: "Queued", variant: "purple" },
  processing: { label: "Processing", variant: "info" },
  paused: { label: "Paused", variant: "warning" },
  done: { label: "Done", variant: "success" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "warning" },
  deleted: { label: "Deleted", variant: "destructive" },
  missing: { label: "Missing", variant: "outline" },
};

const outcomeConfig: Record<RunOutcome, { label: string; variant: BadgeVariant }> = {
  succeeded: { label: "Succeeded", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  finished: { label: "Finished", variant: "warning" },
};

/**
 * Render a positive elapsed duration as a string composed of the two
 * largest non-zero units. Picks "1m 5s" / "2h 14m" / "3d 4h" so the
 * value reads naturally while staying precise enough to diagnose
 * stalled runs.
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatRelative(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  return `${formatDuration(ms)} ago`;
}

/**
 * Re-renders every `intervalMs` while `enabled` is true, returning the
 * current wall-clock millisecond timestamp. Used to keep relative-time
 * displays (e.g. "5s ago") ticking without the parent re-rendering.
 */
function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(serverNow()), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}

export function StatusBadge({
  status,
  worker,
  lastHeartbeatAt,
  startedAt,
}: {
  status: StatusBadgeStatus;
  worker?: RunState["worker"];
  lastHeartbeatAt?: RunState["lastHeartbeatAt"];
  startedAt?: RunState["startedAt"];
}) {
  const config = statusConfig[status] ?? { label: status, variant: "outline" as const };
  // Tick once per second while processing so both the live "Ns ago" tooltip
  // value and the heartbeat-freshness check below advance over time.
  const now = useNow(status === "processing");
  const pulsing =
    status === "processing" &&
    shouldPulse(status, lastHeartbeatAt, now, startedAt);
  const className = pulsing ? "animate-shimmer" : undefined;
  const staleClassName = status === "processing" && !pulsing ? "opacity-50" : undefined;
  const badge = <Badge variant={config.variant} className={cn(className, staleClassName)}>{config.label}</Badge>;

  const showTooltip = status === "processing" && (worker || lastHeartbeatAt || startedAt);

  if (!showTooltip) return badge;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper so the tooltip works even when the badge has no
              focusable behavior of its own */}
          <span className="inline-flex">{badge}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-0.5 text-xs">
            {worker && (
              <>
                <div>
                  <span className="text-muted-foreground">Worker: </span>
                  <span className="font-mono">{worker.instanceId}</span>
                </div>
                {worker.podName && (
                  <div>
                    <span className="text-muted-foreground">Pod: </span>
                    <span className="font-mono">{worker.podName}</span>
                  </div>
                )}
              </>
            )}
            {lastHeartbeatAt && (
              <div>
                <span className="text-muted-foreground">Last heartbeat: </span>
                <span>{formatRelative(lastHeartbeatAt, now)}</span>
              </div>
            )}
            {startedAt && (
              <div>
                <span className="text-muted-foreground">Duration: </span>
                <span>{formatDuration(now - new Date(startedAt).getTime())}</span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function OutcomeBadge({ outcome }: { outcome?: RunOutcome }) {
  if (!outcome) return <span className="text-xs text-muted-foreground">–</span>;
  const config = outcomeConfig[outcome] ?? { label: outcome, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
