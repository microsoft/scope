// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { RetryConfirmDialog } from "@/components/RetryConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge, OutcomeBadge } from "@/components/StatusBadge";
import { EnrichmentBadge } from "@/components/EnrichmentBadge";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { LogViewer } from "@/components/LogViewer";
import { TurnTimeline } from "@/components/TurnTimeline";
import { CriteriaGraphView } from "@/components/CriteriaGraphView";
import { HarNetworkViewer } from "@/components/HarNetworkViewer";
import { ConversationView } from "@/components/ConversationView";
import { VideoPlayer } from "@/components/VideoPlayer";
import { useLogStream } from "@/hooks/use-log-stream";
import { useAllTurnsToolCalls } from "@/hooks/useHarExtraction";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ReportThumbnail } from "@/components/ReportThumbnail";
import { CriteriaBadge } from "@/components/CriteriaBadge";
import { ArrowLeft, Copy, Check, Sparkles, CheckCircle2, XCircle, MinusCircle, FileText, Plus, Download, Loader2, Archive, Video, LayoutGrid, List, Puzzle, RotateCcw, ChevronDown, Clock, Pause, Play, ArrowUpDown, X } from "lucide-react";
import { formatDate, formatId, formatDuration } from "@/lib/utils";
import { useState, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import type { RunState } from "@/types";
import { useShiftModifier } from "@/hooks/useShiftModifier";
import { getRetryButtonState } from "@/components/RetryButton";
import { CliCommand } from "@/components/CliCommand";
import { buildRunGet } from "@/lib/cli/buildCommand";

/** A compact labeled stat: a micro uppercase label above its value. */
function MetaItem({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">{label}</span>
      <span className="text-sm leading-tight text-foreground">{value}</span>
    </div>
  );
}

/** A labeled group of resource chips (MCP servers, skills, extensions). */
function ResourceLinks({ label, items, hrefBase }: { label: string; items: string[]; hrefBase: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">{label}</span>
      <div className="flex flex-wrap items-center gap-1">
        {items.map((slug) => (
          <Link
            key={slug}
            to={`${hrefBase}/${slug}`}
            className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
          >
            {slug}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function RunDetail() {
  const { id, tab } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const selectedRunId = searchParams.get("runId");
  const [copied, setCopied] = useState(false);
  const [reportsView, setReportsView] = useState<"grid" | "list">("grid");
  const [reportsFilter, setReportsFilter] = useState<"latest" | "all">("latest");
  const [showAttempts, setShowAttempts] = useState(false);
  const [retryConfirmOpen, setRetryConfirmOpen] = useState(false);
  const isForceRetryModifierActive = useShiftModifier();

  const { data: run, isLoading, error } = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.getRun(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data;
      const status = data?.run?.status;
      const ppStatus = data?.run?.postProcessorStatus;
      // Keep polling while run is in progress OR post-processing is pending/in-progress
      if (status !== "done") return 5_000;
      if (ppStatus && ppStatus !== "done" && ppStatus !== "failed") return 5_000;
      return false;
    },
  });

  const { data: profile } = useQuery({
    queryKey: ["profile", run?.profileId],
    queryFn: () => api.getProfile(run!.profileId!),
    enabled: !!run?.profileId,
  });

  // Fetch all attempts when this request has been retried
  const hasMultipleAttempts = (run?.run?.attemptNumber ?? 1) > 1;
  const { data: rawAttempts } = useQuery({
    queryKey: ["run-attempts", id],
    queryFn: () => api.listRunAttempts(id!),
    enabled: !!id && hasMultipleAttempts,
  });

  // Merge the live run.run into the attempts list so the latest attempt
  // always reflects the freshest polled state (status, outcome, duration, etc.)
  const attempts = useMemo(() => {
    if (!rawAttempts) return rawAttempts;
    const liveRun = run?.run;
    if (!liveRun) return rawAttempts;
    return rawAttempts.map((a) => (a._id === liveRun._id ? liveRun : a));
  }, [rawAttempts, run?.run]);

  // When viewing a historical attempt via ?runId=xxx, use that RunState
  // instead of the current one. The selected attempt may come from the
  // attempts list or fall back to the current run.
  const activeRun: RunState | undefined = useMemo(() => {
    if (!selectedRunId || selectedRunId === run?.run?._id) return run?.run;
    return attempts?.find((a) => a._id === selectedRunId) ?? run?.run;
  }, [selectedRunId, run?.run, attempts]);
  const isViewingHistorical = !!selectedRunId && selectedRunId !== run?.run?._id;

  const isActive = activeRun?.status === "pending" || activeRun?.status === "processing";
  // Note: "done" is terminal — not active, no log streaming needed

  // Lift the log stream so it can be shared between LogViewer and CriteriaGraphView
  // Must be called unconditionally (before any early returns) per Rules of Hooks
  // The SSE endpoint handles completed runs by replaying blob logs then closing.
  // When viewing a historical run, use the per-run logs endpoint; otherwise use the
  // default endpoint with attemptNumber for reconnection on retry.
  const logStreamUrlBuilder = useMemo(() => {
    if (isViewingHistorical && activeRun?._id && run?._id) {
      const requestId = run._id;
      const runId = activeRun._id;
      return (_id: string, fromStart: boolean) => api.runLogsUrl(requestId, runId, fromStart);
    }
    return api.logsUrl;
  }, [isViewingHistorical, activeRun?._id, run?._id]);

  const logStream = useLogStream({
    id: run?._id ?? "",
    enabled: !!run,
    fromStart: true,
    attemptNumber: activeRun?.attemptNumber,
    urlBuilder: logStreamUrlBuilder,
  });

  const effectiveLogs = logStream.logs;
  const effectiveIsConnected = isActive ? logStream.isConnected : false;
  const effectiveIsDone = logStream.isDone;
  const effectiveError = logStream.error;

  // Fetch linked task prompt (if present) — provides prompt features
  const taskPromptId = run?.taskPromptId;
  const { data: taskPrompt } = useQuery({
    queryKey: ["task-prompt", taskPromptId],
    queryFn: () => api.getTaskPrompt(taskPromptId!),
    enabled: !!taskPromptId,
  });

  // Fetch reports for this run
  const { data: reports, refetch: refetchReports } = useQuery({
    queryKey: ["run-reports", id],
    queryFn: () => api.getRunReports(id!),
    enabled: !!id,
    refetchInterval: 10_000,
  });

  // Fetch report templates for name resolution
  const { data: reportTemplates } = useQuery({
    queryKey: ["report-templates"],
    queryFn: () => api.listReportTemplates(),
  });
  const templateMap = new Map(reportTemplates?.map((t) => [t.id, t.name]));

  // Filter reports: "latest" keeps only the most recent per templateId
  const filteredReports = useMemo(() => {
    if (!reports) return [];
    if (reportsFilter === "all") return reports;
    const seen = new Map<string, boolean>();
    return reports
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .filter((r) => {
        const key = r.templateId ?? r._id; // manual reports always shown
        if (seen.has(key)) return false;
        seen.set(key, true);
        return true;
      });
  }, [reports, reportsFilter]);

  const generateReport = useMutation({
    mutationFn: () => api.triggerReports(id!),
    onSuccess: (data) => {
      toast.success(`${data.triggered} report(s) queued`);
      refetchReports();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to generate report");
    },
  });

  const retryMutation = useMutation({
    mutationFn: (options?: { force?: boolean }) => api.retryRun(id!, options),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["run", id] });
      toast.success(`Retry started — attempt #${data.attemptNumber}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to retry");
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () => api.pauseRun(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["run", id] });
      toast.success("Run paused");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to pause");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelRun(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["run", id] });
      toast.success("Run cancelled");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to cancel");
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => api.resumeRun(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["run", id] });
      toast.success("Run resumed");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to resume");
    },
  });

  const setPriorityMutation = useMutation({
    mutationFn: (priority: number) => api.setPriority(id!, priority),
    onSuccess: (_data, priority) => {
      queryClient.invalidateQueries({ queryKey: ["run", id] });
      toast.success(`Priority set to ${priority}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to set priority");
    },
  });

  const copyId = () => {
    navigator.clipboard.writeText(id ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // For completed runs, use the FINAL turn's criteriaResults to build a
  // criterionId -> pass/fail/undefined lookup map.
  // Using the final turn (not the latest turn with any results) avoids
  // presenting stale pass/fail state from an earlier iteration when the
  // last turn ended without evaluation (e.g. judge failure).
  // "not evaluated" is preserved as undefined so skipped criteria are not
  // collapsed into a failing `false` state.
  const latestCriteriaResultsMap = useMemo(() => {
    if (activeRun?.status !== "done") return undefined;
    const turns = activeRun?.turns ?? [];
    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
    if (!lastTurn?.criteriaResults?.length) return new Map<string, boolean | undefined>();

    return new Map<string, boolean | undefined>(
      lastTurn.criteriaResults.map((r) => [
        r.criterionId,
        r.evaluated ? r.passed : undefined,
      ])
    );
  }, [activeRun?.status, activeRun?.turns]);

  // Prefer scenario criteria as the canonical list.
  // If unavailable on a completed run, fall back to whatever the judge evaluated.
  const displayedCriteria = useMemo(() => {
    if ((run?.scenario?.criteria?.length ?? 0) > 0) return run?.scenario?.criteria ?? [];
    if (activeRun?.status === "done" && latestCriteriaResultsMap) {
      return Array.from(latestCriteriaResultsMap.keys());
    }
    return [] as string[];
  }, [run?.scenario?.criteria, activeRun?.status, latestCriteriaResultsMap]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="space-y-4">
        <Link to="/runs">
          <Button variant="ghost" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Back to runs
          </Button>
        </Link>
        <div className="text-center py-12 text-destructive">
          {error instanceof Error ? error.message : "Run not found"}
        </div>
      </div>
    );
  }

  const hasHarData = !!(activeRun?.harUrl || activeRun?.turns?.some(t => t.harUrl));
  const hasVideoData = !!(activeRun?.videoUrls?.length || activeRun?.setupVideoUrls?.length || activeRun?.turns?.some(t => t.videoUrls?.length));
  const videoCount = (activeRun?.setupVideoUrls?.length ?? 0)
    + (activeRun?.videoUrls?.length ?? 0)
    + (activeRun?.turns?.reduce((n, t) => n + (t.videoUrls?.length ?? 0), 0) ?? 0);
  const isSuccessfulCompletedRun = activeRun?.status === "done" && activeRun?.outcome === "succeeded";
  const canShowRetry = !isViewingHistorical && activeRun?.status === "done";
  const retryButtonState = getRetryButtonState(!!isSuccessfulCompletedRun, retryMutation.isPending, isForceRetryModifierActive);

  // Compute aggregate token usage: for one-shot runs use activeRun?.tokenUsage,
  // for multi-turn runs sum per-turn token usage
  const totalTokenUsage = activeRun?.tokenUsage
    ?? (activeRun?.turns?.some(t => t.tokenUsage)
      ? activeRun?.turns!.reduce(
          (acc, t) => {
            if (!t.tokenUsage) return acc;
            return {
              promptTokens: acc.promptTokens + t.tokenUsage.promptTokens,
              completionTokens: acc.completionTokens + t.tokenUsage.completionTokens,
              totalTokens: acc.totalTokens + t.tokenUsage.totalTokens,
            };
          },
          { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        )
      : undefined);

   const skillIdsFromRevisions = Array.from(new Set((run.skillRevisions ?? []).map((ref) => {
     const at = ref.lastIndexOf("@");
     return at > 0 ? ref.substring(0, at) : ref;
   })));
   const skillIds = skillIdsFromRevisions.length > 0
     ? skillIdsFromRevisions
     : (run.skills ?? []);

  return (
    <TooltipProvider delayDuration={200}>
    <div className="space-y-6">
      {/* Back link + header */}
      <div>
        <Link to="/runs">
          <Button variant="ghost" size="sm" className="gap-1.5 mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to runs
          </Button>
        </Link>

        <div className="flex items-start justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight font-mono">{id}</h1>
              <button
                onClick={copyId}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Copy run ID"
                title="Copy run ID"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                <span className="sr-only">Copy run ID</span>
              </button>
              <CliCommand command={buildRunGet(id ?? "")} align="start" />
            </div>

            {/* Tier 1 — semantic status pills */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                status={activeRun?.status ?? "pending"}
                worker={activeRun?.worker}
                lastHeartbeatAt={activeRun?.lastHeartbeatAt}
                startedAt={activeRun?.startedAt}
              />
              {activeRun?.status === "done" && <OutcomeBadge outcome={activeRun?.outcome} />}
              {activeRun?.status === "done" && (
                <EnrichmentBadge status={activeRun.postProcessorStatus} version={activeRun.postProcessorVersion} />
              )}
            </div>

            {/* Tier 2 — labeled configuration + metrics */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <MetaItem label="Worker" value={<span className="font-mono">{run.workerType}</span>} />
              {run.model && (
                <MetaItem
                  label="Model"
                  value={
                    <span className="font-mono">
                      {run.model}
                      {run.reasoningEffort && ` (${run.reasoningEffort})`}
                    </span>
                  }
                />
              )}
              {run.agentVersion && (
                <MetaItem
                  label="Version"
                  title={activeRun?.workerVersion ? `Worker: ${activeRun?.workerVersion}` : undefined}
                  value={<span className="font-mono">{run.agentVersion}</span>}
                />
              )}
              <MetaItem label="Created" value={formatDate(run.createdAt)} />
              {run.maxIterations && <MetaItem label="Max iterations" value={run.maxIterations} />}
              {(() => {
                const totalDuration = activeRun?.turns?.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
                return totalDuration ? (
                  <MetaItem
                    label="Duration"
                    title={`${totalDuration.toLocaleString()}ms total`}
                    value={<span className="font-mono">{formatDuration(totalDuration)}</span>}
                  />
                ) : null;
              })()}
              {totalTokenUsage && (
                <MetaItem
                  label="Tokens (in/out)"
                  value={
                    <span className="font-mono">
                      {totalTokenUsage.promptTokens.toLocaleString()}↑ · {totalTokenUsage.completionTokens.toLocaleString()}↓
                    </span>
                  }
                />
              )}
              {activeRun?.aiCallCount !== undefined && (
                <MetaItem
                  label="LLM calls"
                  title="LLM completion calls"
                  value={<span className="font-mono">{activeRun?.aiCallCount}</span>}
                />
              )}
            </div>

            {/* Tier 3 — resource attachments */}
            {((run.mcpServers && run.mcpServers.length > 0) ||
              (run.skills && run.skills.length > 0) ||
              (run.extensions && run.extensions.length > 0)) && (
              <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                {run.mcpServers && run.mcpServers.length > 0 && (
                  <ResourceLinks label="MCP" items={run.mcpServers} hrefBase="/mcp-servers" />
                )}
                {run.skills && run.skills.length > 0 && (
                  <ResourceLinks label="Skills" items={run.skills} hrefBase="/skills" />
                )}
                {run.extensions && run.extensions.length > 0 && (
                  <ResourceLinks label="Extensions" items={run.extensions} hrefBase="/extensions" />
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
          {hasMultipleAttempts && attempts && attempts.length > 0 && (
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 font-mono"
                onClick={() => setShowAttempts((v) => !v)}
              >
                <Clock className="h-3.5 w-3.5" />
                Attempt {activeRun?.attemptNumber}/{attempts.length}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAttempts ? "rotate-180" : ""}`} />
              </Button>
              {showAttempts && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowAttempts(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border bg-popover shadow-md">
                    <div className="max-h-60 overflow-y-auto divide-y">
                      {attempts.map((attempt) => {
                        const isCurrent = attempt._id === run.run?._id;
                        const isSelected = attempt._id === activeRun?._id;
                        const duration = attempt.turns?.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
                        return (
                          <button
                            key={attempt._id}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors ${isSelected ? "bg-accent" : ""}`}
                            onClick={() => {
                              setShowAttempts(false);
                              if (isCurrent) {
                                navigate(`/runs/${id}/${tab ?? ""}`, { replace: true });
                              } else {
                                navigate(`/runs/${id}/${tab ?? ""}?runId=${attempt._id}`, { replace: true });
                              }
                            }}
                          >
                            <span className="font-mono font-medium w-5 text-right">#{attempt.attemptNumber}</span>
                            <StatusBadge
                              status={attempt.status ?? "pending"}
                              worker={attempt.worker}
                              lastHeartbeatAt={attempt.lastHeartbeatAt}
                              startedAt={attempt.startedAt}
                            />
                            {attempt.status === "done" && <OutcomeBadge outcome={attempt.outcome} />}
                            {duration ? (
                              <span className="font-mono text-muted-foreground">{formatDuration(duration)}</span>
                            ) : null}
                            {isCurrent && (
                              <span className="text-muted-foreground font-medium ml-auto">(latest)</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {activeRun?.turns && activeRun?.turns.some(t => t.snapshotUrl) && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => window.open(isViewingHistorical && activeRun?._id ? api.runArchiveUrl(run._id, activeRun._id) : api.archiveUrl(run._id), "_blank")}
            >
              <Archive className="h-4 w-4" />
              Download Archive
            </Button>
          )}
          {canShowRetry && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                if (isSuccessfulCompletedRun) {
                  setRetryConfirmOpen(true);
                } else {
                  retryMutation.mutate({ force: false });
                }
              }}
              disabled={retryButtonState.disabled}
              title={retryButtonState.title}
            >
              <RotateCcw className="h-4 w-4" />
              {retryMutation.isPending ? "Retrying…" : "Retry"}
            </Button>
          )}
          {(activeRun?.status === "pending" || activeRun?.status === "queued") && !isViewingHistorical && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => pauseMutation.mutate()}
              disabled={pauseMutation.isPending}
            >
              <Pause className="h-4 w-4" />
              {pauseMutation.isPending ? "Pausing…" : "Pause"}
            </Button>
          )}
          {(activeRun?.status === "pending" || activeRun?.status === "queued" || activeRun?.status === "processing") && !isViewingHistorical && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive border-destructive/50 hover:bg-destructive/10"
              onClick={() => {
                if (window.confirm("Are you sure you want to cancel this run? This will mark it as failed and kill any active worker.")) {
                  cancelMutation.mutate();
                }
              }}
              disabled={cancelMutation.isPending}
            >
              <X className="h-4 w-4" />
              {cancelMutation.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          )}
          {activeRun?.status === "paused" && !isViewingHistorical && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => resumeMutation.mutate()}
              disabled={resumeMutation.isPending}
            >
              <Play className="h-4 w-4" />
              {resumeMutation.isPending ? "Resuming…" : "Resume"}
            </Button>
          )}
          {(activeRun?.status === "pending" || activeRun?.status === "paused") && !isViewingHistorical && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ArrowUpDown className="h-4 w-4" />
                  Priority{run.priority ? ` (${run.priority > 0 ? "+" : ""}${run.priority})` : ""}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Set Priority</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {[10, 5, 0, -5, -10].map((p) => (
                  <DropdownMenuCheckboxItem
                    key={p}
                    checked={(run.priority ?? 0) === p}
                    onCheckedChange={() => setPriorityMutation.mutate(p)}
                  >
                    {p > 0 ? `+${p}` : p} {p === 0 ? "(default)" : p > 0 ? "(higher)" : "(lower)"}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          </div>
        </div>
      </div>

      {/* Historical attempt banner */}
      {isViewingHistorical && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          <Clock className="h-4 w-4 shrink-0" />
          <span>
            Viewing attempt #{activeRun?.attemptNumber} (historical).{" "}
            <button
              className="underline hover:no-underline font-medium"
              onClick={() => navigate(`/runs/${id}/${tab ?? ""}`, { replace: true })}
            >
              View latest attempt
            </button>
          </span>
        </div>
      )}

      {/* Tabs */}
      <Tabs
        value={tab || (activeRun?.turns && activeRun?.turns.length > 0 ? "turns" : "logs")}
        onValueChange={(value) => navigate(`/runs/${id}/${value}${selectedRunId ? `?runId=${selectedRunId}` : ""}`)}
      >
        <TabsList>
          <TabsTrigger value="turns">
            Turns {activeRun?.turns ? `(${activeRun?.turns.length})` : ""}
          </TabsTrigger>
          {activeRun?.turns && activeRun?.turns.length > 0 && (
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
          )}
          {hasHarData && <TabsTrigger value="network">Network</TabsTrigger>}
          {hasHarData && <TabsTrigger value="tool-calls">Tool Calls</TabsTrigger>}
          {hasVideoData && <TabsTrigger value="video"><Video className="h-3.5 w-3.5 mr-1" />Videos ({videoCount})</TabsTrigger>}
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="reports">
            Reports {reports && reports.length > 0 ? `(${reports.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>

        {/* Turns tab */}
        <TabsContent value="turns" className="mt-4">
          <TurnTimeline turns={activeRun?.turns ?? []} runId={run._id} attemptRunId={isViewingHistorical ? activeRun?._id : undefined} />
        </TabsContent>

        {/* Conversation tab — chat-style view of agent/judge exchanges */}
        {activeRun?.turns && activeRun?.turns.length > 0 && (
          <TabsContent value="conversation" className="mt-4">
            <ConversationView turns={activeRun?.turns} task={run.scenario?.task} runId={run._id} attemptRunId={isViewingHistorical ? activeRun?._id : undefined} />
          </TabsContent>
        )}

        {/* Network tab — Chrome DevTools-style HAR viewer */}
        {hasHarData && (
          <TabsContent value="network" className="mt-4">
            {/* If multi-turn, show per-iteration selector; otherwise one viewer */}
            {activeRun?.turns && activeRun?.turns.some(t => t.harUrl) ? (
              <HarIterationTabs runId={run._id} turns={activeRun?.turns} attemptRunId={isViewingHistorical ? activeRun?._id : undefined} />
            ) : (
              <HarNetworkViewer runId={run._id} attemptRunId={isViewingHistorical ? activeRun?._id : undefined} />
            )}
          </TabsContent>
        )}

        {/* Video tab — session recording player */}
        {hasVideoData && (
          <TabsContent value="video" className="mt-4">
            {activeRun?.turns && activeRun?.turns.some(t => t.videoUrls?.length) ? (
              <VideoIterationTabs runId={run._id} turns={activeRun?.turns} setupVideoUrls={activeRun?.setupVideoUrls} attemptRunId={isViewingHistorical ? activeRun?._id : undefined} />
            ) : (
              <div className="space-y-4">
                {activeRun?.setupVideoUrls && activeRun?.setupVideoUrls.length > 0 && (
                  activeRun?.setupVideoUrls.map((_, i) => (
                    <VideoPlayer key={`setup-${i}`} src={isViewingHistorical && activeRun?._id ? api.runVideoUrl(run._id, activeRun._id, undefined, i, "setup") : api.videoUrl(run._id, undefined, i, "setup")} label="Setup" />
                  ))
                )}
                {activeRun?.videoUrls && activeRun?.videoUrls.length > 0 && (
                  activeRun?.videoUrls.map((_, i) => (
                    <VideoPlayer key={i} src={isViewingHistorical && activeRun?._id ? api.runVideoUrl(run._id, activeRun._id, undefined, i) : api.videoUrl(run._id, undefined, i)} label={(activeRun?.videoUrls?.length ?? 0) > 1 ? `Video ${i + 1}` : undefined} />
                  ))
                )}
              </div>
            )}
          </TabsContent>
        )}

        {/* Logs tab */}
        <TabsContent value="logs" className="mt-4 space-y-4">
          {run.scenario?.criteria && run.scenario.criteria.length > 0 && (
            <CriteriaGraphView
              scenarioCriteria={run.scenario!.criteria}
              logs={effectiveLogs}
            />
          )}
          <LogViewer
            runId={run._id}
            enabled={isActive}
            logs={effectiveLogs}
            isConnected={effectiveIsConnected}
            isDone={effectiveIsDone}
            error={effectiveError}
          />
        </TabsContent>

        {/* Reports tab */}
        <TabsContent value="reports" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium">Reports</h3>
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-md border">
                <Button
                  variant={reportsFilter === "latest" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 rounded-r-none text-xs"
                  onClick={() => setReportsFilter("latest")}
                >
                  Latest
                </Button>
                <Button
                  variant={reportsFilter === "all" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 rounded-l-none text-xs"
                  onClick={() => setReportsFilter("all")}
                >
                  All{reports && reports.length > 0 ? ` (${reports.length})` : ""}
                </Button>
              </div>
              <div className="flex items-center rounded-md border">
                <Button
                  variant={reportsView === "grid" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-r-none"
                  onClick={() => setReportsView("grid")}
                  aria-label="Grid view"
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
                <Button
                  variant={reportsView === "list" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-l-none"
                  onClick={() => setReportsView("list")}
                  aria-label="List view"
                >
                  <List className="h-4 w-4" />
                </Button>
              </div>
              <Button
                size="sm"
                onClick={() => generateReport.mutate()}
                disabled={generateReport.isPending}
                className="gap-1.5"
              >
                <Plus className="h-4 w-4" />
                Generate Report
              </Button>
            </div>
          </div>

          {filteredReports.length > 0 ? (
            reportsView === "grid" ? (
              <div className="flex flex-wrap gap-4">
                {filteredReports.map((report) => (
                  <Link
                    key={report._id}
                    to={`/reports/${report._id}`}
                    className="group block"
                  >
                    <div className="flex flex-col items-center gap-2 w-[280px]">
                      {report.status === "completed" && report.content ? (
                        <ReportThumbnail content={report.content} />
                      ) : (
                        <div className="flex items-center justify-center rounded border bg-muted/30 shadow-sm" style={{ width: 280, height: 360 }}>
                          {report.status === "generating" ? (
                            <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
                          ) : (
                            <FileText className="h-8 w-8 text-muted-foreground opacity-50" />
                          )}
                        </div>
                      )}
                      <div className="text-center w-full">
                        <p className="text-xs font-medium truncate group-hover:underline">
                          {report.templateId ? (templateMap.get(report.templateId) ?? report.templateId) : "Manual report"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">{formatDate(report.createdAt)}</p>
                        <div className="flex items-center justify-center gap-1.5 mt-0.5">
                          <ReportStatusBadge status={report.status} />
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {filteredReports.map((report) => (
                  <Card key={report._id}>
                    <CardContent className="flex items-center justify-between py-4">
                      <div className="flex items-center gap-4">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <Link
                            to={`/reports/${report._id}`}
                            className="text-sm font-medium text-primary hover:underline"
                          >
                            {report.templateId ? (templateMap.get(report.templateId) ?? report.templateId) : "Manual report"}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(report.createdAt)}
                            {report.reporter?.model && ` · ${report.reporter.model}`}
                            {" · "}
                            <span className="font-mono">{formatId(report._id)}</span>
                          </p>
                        </div>
                      </div>
                      <ReportStatusBadge status={report.status} />
                    </CardContent>
                  </Card>
                ))}
              </div>
            )
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No reports for this run yet.</p>
            </div>
          )}
        </TabsContent>

        {/* Details tab */}
        <TabsContent value="details" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Scenario card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Scenario</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <h4 className="text-sm font-medium mb-1">Task</h4>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-5 cursor-default">
                        {run.scenario?.task ?? "–"}
                      </p>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm whitespace-pre-wrap">
                      {run.scenario?.task ?? "–"}
                    </TooltipContent>
                  </Tooltip>
                </div>
                {run.scenario?.version && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Version</h4>
                    <Badge variant="outline">{run.scenario!.version}</Badge>
                  </div>
                )}
                {displayedCriteria.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Criteria ({displayedCriteria.length})</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {displayedCriteria.map((c) => {
                        return (
                          <CriteriaBadge
                            key={c}
                            criterionId={c}
                            result={latestCriteriaResultsMap?.get(c)}
                            evaluated={activeRun?.status === "done"}
                            showStateLabel={activeRun?.status === "done"}
                            link={false}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Persona card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Persona</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {run.persona ? (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">Personality:</span>{" "}
                      <span className="font-medium">{run.persona.personality}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Experience:</span>{" "}
                      <span className="font-medium">{run.persona.experience}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Verbosity:</span>{" "}
                      <span className="font-medium">{run.persona.verbosity}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Type:</span>{" "}
                      <span className="font-medium">{run.persona.type}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No persona configured</p>
                )}
                {run.personaInstructions && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Instructions</h4>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded-md p-3 max-h-48 overflow-y-auto">
                      {run.personaInstructions}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Profile card */}
            {run.profileId && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Profile</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <div>
                    <span className="text-muted-foreground">Name:</span>{" "}
                    <Link to={`/profiles/${run.profileId}`} className="font-medium text-primary hover:underline">
                      {profile?.name ?? <Skeleton className="inline-block h-4 w-32 align-middle" />}
                    </Link>
                  </div>
                  {run.profileVersionId && (
                    <div>
                      <span className="text-muted-foreground">Version:</span>{" "}
                      <span className="font-medium">
                        {(() => { const v = run.profileVersionId.split("@")[1]; return v ? `v${v}` : run.profileVersionId; })()}
                      </span>
                    </div>
                  )}
                  {profile?.description && (
                    <div>
                      <span className="text-muted-foreground">Description:</span>{" "}
                      <span>{profile.description}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Version Info card */}
            {(run.agentVersion || activeRun?.workerVersion || activeRun?.os) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Version Info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {run.agentVersion && (
                    <div>
                      <span className="text-muted-foreground">Agent Version:</span>{" "}
                      <span className="font-mono font-medium">{run.agentVersion}</span>
                    </div>
                  )}
                  {activeRun?.workerVersion && (
                    <div>
                      <span className="text-muted-foreground">Worker Version:</span>{" "}
                      <span className="font-mono font-medium">{activeRun?.workerVersion}</span>
                    </div>
                  )}
                  {activeRun?.os && (
                    <div>
                      <span className="text-muted-foreground">OS:</span>{" "}
                      <span className="font-mono font-medium">
                        {activeRun?.os.platform}
                        <span className="text-muted-foreground ml-1">(release </span>
                        {activeRun?.os.release}
                        <span className="text-muted-foreground"> arch </span>
                        {activeRun?.os.arch}
                        <span className="text-muted-foreground">)</span>
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Worker Type:</span>{" "}
                    <span className="font-mono font-medium">{run.workerType}</span>
                  </div>
                  {run.model && (
                    <div>
                      <span className="text-muted-foreground">Model:</span>{" "}
                      <span className="font-mono font-medium">{run.model}</span>
                    </div>
                  )}
                  {run.reasoningEffort && (
                    <div>
                      <span className="text-muted-foreground">Reasoning Effort:</span>{" "}
                      <span className="font-mono font-medium">{run.reasoningEffort}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Enrichment card */}
            {activeRun?.status === "done" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Enrichment</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Status:</span>{" "}
                    <EnrichmentBadge status={activeRun.postProcessorStatus} version={activeRun.postProcessorVersion} />
                  </div>
                  {activeRun.postProcessorVersion !== undefined && (
                    <div>
                      <span className="text-muted-foreground">Version:</span>{" "}
                      <span className="font-mono font-medium">v{activeRun.postProcessorVersion}</span>
                    </div>
                  )}
                  {activeRun.postProcessorStatus === "done" && activeRun.turns?.some(t => t.atifUrl) && (
                    <div>
                      <span className="text-muted-foreground">Artifacts:</span>{" "}
                      <span className="font-medium">ATIF trajectory</span>
                      <span className="text-muted-foreground ml-1">
                        ({activeRun.turns?.filter(t => t.atifUrl).length ?? 0} iteration{(activeRun.turns?.filter(t => t.atifUrl).length ?? 0) !== 1 ? "s" : ""})
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Extensions card */}
            {run.extensions && run.extensions.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Puzzle className="h-4 w-4" /> Extensions ({run.extensions.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    {run.extensions.map((ext) => {
                      const at = ext.lastIndexOf("@");
                      const id = at > 0 ? ext.substring(0, at) : ext;
                      const version = at > 0 ? ext.substring(at + 1) : undefined;
                      return (
                        <Badge key={ext} variant="secondary" className="font-mono text-xs">
                          {id}{version && <span className="text-muted-foreground ml-1">@{version}</span>}
                        </Badge>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Skills card */}
            {skillIds.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    Skills ({skillIds.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    {skillIds.map((skillId) => (
                      <Link key={skillId} to={`/skills/${skillId}`}>
                        <Badge variant="secondary" className="font-mono text-xs hover:bg-accent transition-colors">
                          {skillId}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Prompt Features card (if task prompt has features) */}
            {taskPrompt?.features && taskPrompt.features.length > 0 && (
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Sparkles className="h-4 w-4" /> Prompt Features
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(() => {
                    const detected = taskPrompt.features!.filter((f) => f.detected);
                    const notDetected = taskPrompt.features!.filter((f) => !f.detected && f.evaluated);
                    const skipped = taskPrompt.features!.filter((f) => !f.evaluated);
                    return (
                      <>
                        {detected.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                              Detected ({detected.length})
                            </h4>
                            <div className="flex flex-wrap gap-1.5">
                              {detected.map((f) => (
                                <Badge key={f.featureId} variant="default" className="gap-1 font-mono text-xs">
                                  <CheckCircle2 className="h-3 w-3" />
                                  {f.featureId}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {notDetected.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                              Not detected ({notDetected.length})
                            </h4>
                            <div className="flex flex-wrap gap-1.5">
                              {notDetected.map((f) => (
                                <Badge key={f.featureId} variant="outline" className="gap-1 font-mono text-xs text-muted-foreground">
                                  <XCircle className="h-3 w-3" />
                                  {f.featureId}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {skipped.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                              Skipped ({skipped.length})
                            </h4>
                            <div className="flex flex-wrap gap-1.5">
                              {skipped.map((f) => (
                                <Badge key={f.featureId} variant="outline" className="gap-1 font-mono text-xs text-muted-foreground/50">
                                  <MinusCircle className="h-3 w-3" />
                                  {f.featureId}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </CardContent>
              </Card>
            )}

            {/* Error card (if failed) */}
            {activeRun?.error && (
              <Card className="md:col-span-2 border-destructive">
                <CardHeader>
                  <CardTitle className="text-lg text-destructive">Error</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-sm text-destructive whitespace-pre-wrap font-mono bg-destructive/10 rounded-md p-3">
                    {activeRun?.error}
                  </pre>
                </CardContent>
              </Card>
            )}

            {/* Result card */}
            {activeRun?.result && (
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-lg">Result</CardTitle>
                </CardHeader>
                <CardContent className="prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownRenderer>{activeRun?.result}</MarkdownRenderer>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Tool Calls tab — HAR captures & tool calls summary */}
        {hasHarData && (
          <TabsContent value="tool-calls" className="mt-4 space-y-4">
            <ToolCallsTab runId={run._id} turns={activeRun?.turns} harUrl={activeRun?.harUrl} attemptRunId={isViewingHistorical ? activeRun?._id : undefined} />
          </TabsContent>
        )}
      </Tabs>

      <RetryConfirmDialog
        open={retryConfirmOpen}
        onOpenChange={setRetryConfirmOpen}
        onConfirm={() => retryMutation.mutate({ force: true })}
        isPending={retryMutation.isPending}
      />
    </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Helper: per-iteration HAR viewer tabs for multi-turn runs
// ---------------------------------------------------------------------------

function HarIterationTabs({ runId, turns, attemptRunId }: { runId: string; turns: { iteration: number; harUrl?: string }[]; attemptRunId?: string }) {
  const turnsWithHar = turns.filter(t => t.harUrl);
  const [activeIteration, setActiveIteration] = useState(turnsWithHar[0]?.iteration);

  if (turnsWithHar.length === 0) return null;

  // Single iteration — no sub-tabs needed
  if (turnsWithHar.length === 1) {
    return <HarNetworkViewer runId={runId} iteration={turnsWithHar[0].iteration} attemptRunId={attemptRunId} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 flex-wrap">
        {turnsWithHar.map(t => (
          <Button
            key={t.iteration}
            variant={activeIteration === t.iteration ? "default" : "outline"}
            size="sm"
            className="font-mono text-xs"
            onClick={() => setActiveIteration(t.iteration)}
          >
            Iteration {t.iteration}
          </Button>
        ))}
      </div>
      {activeIteration !== undefined && (
        <HarNetworkViewer runId={runId} iteration={activeIteration} attemptRunId={attemptRunId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: per-iteration video player tabs for multi-turn runs
// ---------------------------------------------------------------------------

function VideoIterationTabs({ runId, turns, setupVideoUrls, attemptRunId }: { runId: string; turns: { iteration: number; videoUrls?: string[] }[]; setupVideoUrls?: string[]; attemptRunId?: string }) {
  const turnsWithVideo = turns.filter(t => t.videoUrls && t.videoUrls.length > 0);
  const hasSetupVideo = setupVideoUrls && setupVideoUrls.length > 0;
  const [activeTab, setActiveTab] = useState<string>(hasSetupVideo ? "setup" : String(turnsWithVideo[0]?.iteration));

  if (turnsWithVideo.length === 0 && !hasSetupVideo) return null;

  const activeTurn = turnsWithVideo.find(t => String(t.iteration) === activeTab);
  const videoUrlFn = attemptRunId
    ? (iteration?: number, index?: number, phase?: string) => api.runVideoUrl(runId, attemptRunId, iteration, index, phase)
    : (iteration?: number, index?: number, phase?: string) => api.videoUrl(runId, iteration, index, phase);

  return (
    <div className="space-y-3">
      {(hasSetupVideo || turnsWithVideo.length > 1) && (
        <div className="flex gap-1.5 flex-wrap">
          {hasSetupVideo && (
            <Button
              variant={activeTab === "setup" ? "default" : "outline"}
              size="sm"
              className="font-mono text-xs"
              onClick={() => setActiveTab("setup")}
            >
              Setup
            </Button>
          )}
          {turnsWithVideo.map(t => (
            <Button
              key={t.iteration}
              variant={activeTab === String(t.iteration) ? "default" : "outline"}
              size="sm"
              className="font-mono text-xs"
              onClick={() => setActiveTab(String(t.iteration))}
            >
              Iteration {t.iteration}
            </Button>
          ))}
        </div>
      )}
      {activeTab === "setup" && hasSetupVideo && (
        <div className="space-y-4">
          {setupVideoUrls.map((_, i) => (
            <VideoPlayer
              key={`setup-${i}`}
              src={videoUrlFn(undefined, i, "setup")}
              label={setupVideoUrls.length > 1 ? `Setup Video ${i + 1}` : "Setup"}
            />
          ))}
        </div>
      )}
      {activeTab !== "setup" && activeTurn && (
        <div className="space-y-4">
          {activeTurn.videoUrls!.map((_, i) => (
            <VideoPlayer
              key={`${activeTab}-${i}`}
              src={videoUrlFn(Number(activeTab), i)}
              label={activeTurn.videoUrls!.length > 1 ? `Video ${i + 1}` : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool Calls tab — extracts tool calls from HAR client-side
// ---------------------------------------------------------------------------

import type { ConversationTurn } from "@/types";

/** Truncated text cell that expands on click when content overflows. */
function ExpandableCell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`cursor-pointer ${expanded ? "whitespace-pre-wrap break-all" : "truncate max-w-sm"} ${className}`}
      onClick={() => setExpanded(!expanded)}
      title={expanded ? "Click to collapse" : "Click to expand"}
    >
      {children}
    </div>
  );
}

function ToolCallsTab({ runId, turns, harUrl, attemptRunId }: { runId: string; turns?: ConversationTurn[]; harUrl?: string; attemptRunId?: string }) {
  const { allToolCalls, isLoading } = useAllTurnsToolCalls(runId, turns, harUrl, attemptRunId);

  // Group by tool name for summary
  const byName = new Map<string, number>();
  for (const tc of allToolCalls) {
    byName.set(tc.name, (byName.get(tc.name) ?? 0) + 1);
  }

  const harDownloadUrl = attemptRunId ? api.runHarUrl(runId, attemptRunId) : api.harUrl(runId);
  const harIterationUrl = (iteration: number) => attemptRunId ? api.runHarUrl(runId, attemptRunId, iteration) : api.harUrl(runId, iteration);

  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Network Captures</h3>
        {harUrl && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => window.open(harDownloadUrl, "_blank")}
          >
            <Download className="h-4 w-4" />
            Download HAR
          </Button>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Extracting tool calls from HAR…</span>
        </div>
      )}

      {!isLoading && allToolCalls.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <p>No tool calls captured. HAR file may still be available for download.</p>
        </div>
      )}

      {allToolCalls.length > 0 && (
        <div className="space-y-4">
          {/* Summary badges */}
          <div className="flex flex-wrap gap-2">
            {Array.from(byName.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => (
                <Badge key={name} variant="secondary" className="font-mono text-xs gap-1">
                  {name} <span className="text-muted-foreground">×{count}</span>
                </Badge>
              ))}
          </div>

          {/* Full tool calls table */}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left p-3 font-medium">Iteration</th>
                      <th className="text-left p-3 font-medium">Tool</th>
                      <th className="text-left p-3 font-medium">Arguments</th>
                      <th className="text-left p-3 font-medium">Response</th>
                      <th className="text-left p-3 font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allToolCalls.map((tc, idx) => (
                      <tr key={tc.id || idx} className="border-b last:border-0">
                        <td className="p-3 text-xs text-muted-foreground">
                          {tc._iteration ?? "–"}
                        </td>
                        <td className="p-3">
                          <span className="font-mono text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                            {tc.name}
                          </span>
                        </td>
                        <td className="p-3">
                          <table className="text-xs border-collapse">
                            <tbody>
                              {Object.entries(tc.arguments).map(([key, val]) => (
                                <tr key={key} className="border-b border-border/50 last:border-0">
                                  <td className="pr-2 py-1 text-foreground/70 font-medium whitespace-nowrap align-top border-r border-border/50">{key}</td>
                                  <td className="pl-2 py-1 font-mono text-muted-foreground"><ExpandableCell>{typeof val === "string" ? val : JSON.stringify(val)}</ExpandableCell></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                        <td className="p-3 text-xs font-mono text-muted-foreground">
                          {tc.response ? (
                            <ExpandableCell className="max-w-md">{tc.response}</ExpandableCell>
                          ) : (
                            <span>–</span>
                          )}
                        </td>
                        <td className="p-3">
                          {tc.response ? (
                            <pre className="text-xs text-muted-foreground max-w-md truncate">
                              {tc.response}
                            </pre>
                          ) : (
                            <span className="text-xs text-muted-foreground">–</span>
                          )}
                        </td>
                        <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                          {tc.timestamp ? new Date(tc.timestamp).toLocaleTimeString() : "–"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Per-turn HAR download links */}
          {turns && turns.some(t => t.harUrl) && (
            <div>
              <h4 className="text-sm font-medium mb-2">Per-Turn HAR Files</h4>
              <div className="flex flex-wrap gap-2">
                {turns.filter(t => t.harUrl).map(t => (
                  <Button
                    key={t.iteration}
                    variant="outline"
                    size="sm"
                    className="gap-1 font-mono text-xs"
                    onClick={() => window.open(harIterationUrl(t.iteration), "_blank")}
                  >
                    <Download className="h-3 w-3" />
                    Iteration {t.iteration}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
