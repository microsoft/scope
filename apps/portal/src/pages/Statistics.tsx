// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  BarChart3,
  CheckCircle2,
  RefreshCw,
  Plus,
  Trophy,
  AlertTriangle,
  ArrowRight,
  Activity,
  Clock,
  Repeat,
  FilterX,
  Filter,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { CriteriaFilterBar } from "@/components/CriteriaFilterBar";
import { TaskPromptBadge } from "@/components/TaskPromptBadge";
import { AgentBadge } from "@/components/AgentBadge";
import { HelpTooltip } from "@/components/HelpTooltip";
import { formatDuration, cn } from "@/lib/utils";
import { useFeatureFlags } from "@/contexts/FeatureFlagContext";
import type { AnalysisResponse, TaskWorkerGroup } from "@/types";

// Color palette for chart lines (distinct colors for different groups)
const COLORS = [
  "hsl(221, 83%, 53%)", // blue
  "hsl(142, 71%, 45%)", // green
  "hsl(38, 92%, 50%)", // orange
  "hsl(262, 83%, 58%)", // purple
  "hsl(346, 77%, 50%)", // red
  "hsl(199, 89%, 48%)", // cyan
];

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatNumber(value: number | null, decimals = 1): string {
  if (value === null) return "—";
  return value.toFixed(decimals);
}

function getGroupKey(group: TaskWorkerGroup): string {
  return `${group.task} (${group.workerType})`;
}

function truncateTask(task: string, maxLength = 35): string {
  return task.length > maxLength
    ? task.substring(0, maxLength - 3) + "..."
    : task;
}

/** Build a `/runs` URL pre-filtered to a given task / worker pair. */
function runsLinkFor(
  group: TaskWorkerGroup,
  extra?: Record<string, string>,
): string {
  const params = new URLSearchParams();
  params.set("worker", group.workerType);
  params.set("taskPromptId", group.taskPromptId);
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  return `/runs?${params.toString()}`;
}

// ─── Hero KPI grid ──────────────────────────────────────────────────────────

interface DerivedInsights {
  failedRuns: number;
  inFlightRuns: number;
  topPerformer: TaskWorkerGroup | null;
  needsAttention: TaskWorkerGroup | null;
  avgDurationMs: number | null;
}

function deriveInsights(data: AnalysisResponse): DerivedInsights {
  const { summary, groups } = data;
  const failedRuns = Math.max(0, summary.completedRuns - summary.passedRuns);
  const inFlightRuns = Math.max(0, summary.totalRuns - summary.completedRuns);

  // Top performer: highest pass rate among groups with at least 2 completed runs.
  // Falls back to "any group with completed runs" so small datasets still show
  // something useful.
  const ranked = [...groups]
    .filter((g) => g.completed > 0)
    .sort((a, b) => {
      const ra = a.passed / a.completed;
      const rb = b.passed / b.completed;
      if (rb !== ra) return rb - ra;
      return b.completed - a.completed;
    });
  const topPerformer =
    ranked.find((g) => g.completed >= 2) ?? ranked[0] ?? null;

  // Attention: lowest pass rate among groups with at least one failure. Don't
  // surface this when topPerformer is itself failure-free — there's nothing
  // to complain about.
  const failing = [...groups]
    .filter((g) => g.completed > 0 && g.passed < g.completed)
    .sort((a, b) => {
      const ra = a.passed / a.completed;
      const rb = b.passed / b.completed;
      if (ra !== rb) return ra - rb;
      return b.completed - a.completed;
    });
  const needsAttention = failing[0] ?? null;

  // Average duration across all groups with duration data, weighted by passed.
  let totalMs = 0;
  let n = 0;
  for (const g of groups) {
    if (!g.durationStats) continue;
    totalMs += g.durationStats.mean * g.passed;
    n += g.passed;
  }
  const avgDurationMs = n > 0 ? totalMs / n : null;

  return {
    failedRuns,
    inFlightRuns,
    topPerformer,
    needsAttention,
    avgDurationMs,
  };
}

interface PassRateBarProps {
  passed: number;
  failed: number;
  inFlight: number;
  total: number;
}

/** Stacked horizontal bar: green = passed, red = failed, muted = in flight. */
function PassRateBar({ passed, failed, inFlight, total }: PassRateBarProps) {
  if (total === 0) return null;
  const passPct = (passed / total) * 100;
  const failPct = (failed / total) * 100;
  const inFlightPct = (inFlight / total) * 100;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      {passPct > 0 && (
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${passPct}%` }}
        />
      )}
      {failPct > 0 && (
        <div
          className="h-full bg-destructive transition-all"
          style={{ width: `${failPct}%` }}
        />
      )}
      {inFlightPct > 0 && (
        <div
          className="h-full bg-muted-foreground/40 transition-all"
          style={{ width: `${inFlightPct}%` }}
        />
      )}
    </div>
  );
}

function HeroKpis({
  data,
  insights,
}: {
  data: AnalysisResponse;
  insights: DerivedInsights;
}) {
  const { summary } = data;
  const { failedRuns, inFlightRuns, topPerformer, avgDurationMs } = insights;

  return (
    <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
      {/* Pass rate — hero card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Pass rate</CardTitle>
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        </CardHeader>
        <CardContent className="space-y-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums">
              {summary.completedRuns > 0
                ? formatPercent(summary.overallPassRate)
                : "—"}
            </span>
            <span className="text-xs text-muted-foreground">
              {summary.passedRuns}/{summary.completedRuns} passed
            </span>
          </div>
          <PassRateBar
            passed={summary.passedRuns}
            failed={failedRuns}
            inFlight={inFlightRuns}
            total={summary.totalRuns}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />{" "}
              {summary.passedRuns} passed
            </span>
            {failedRuns > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-destructive" />{" "}
                {failedRuns} failed
              </span>
            )}
            {inFlightRuns > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />{" "}
                {inFlightRuns} in flight
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Total runs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total runs</CardTitle>
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="space-y-1.5">
          <div className="text-3xl font-bold tabular-nums">
            {summary.totalRuns}
          </div>
          <p className="text-xs text-muted-foreground">
            {summary.completedRuns} completed
            {inFlightRuns > 0 && (
              <>
                {" · "}
                <span className="text-foreground/80">
                  {inFlightRuns} in flight
                </span>
              </>
            )}
          </p>
          <Link
            to="/runs"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80"
          >
            View all runs <ArrowRight className="h-3 w-3" />
          </Link>
        </CardContent>
      </Card>

      {/* Avg iterations */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">
            Avg iterations to pass
          </CardTitle>
          <Repeat className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="space-y-1.5">
          <div className="text-3xl font-bold tabular-nums">
            {formatNumber(summary.avgIterationsToPass)}
          </div>
          <p className="text-xs text-muted-foreground">
            across {summary.passedRuns} successful run
            {summary.passedRuns === 1 ? "" : "s"}
          </p>
        </CardContent>
      </Card>

      {/* Avg duration */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Avg duration</CardTitle>
          <Clock className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="space-y-1.5">
          <div className="text-3xl font-bold tabular-nums">
            {avgDurationMs != null ? formatDuration(avgDurationMs) : "—"}
          </div>
          <p className="text-xs text-muted-foreground">
            {topPerformer
              ? `best: ${truncateTask(topPerformer.task, 22)}`
              : "no successful runs yet"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Insights row ───────────────────────────────────────────────────────────

function InsightsRow({ insights }: { insights: DerivedInsights }) {
  const { topPerformer, needsAttention } = insights;
  if (!topPerformer && !needsAttention) return null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {topPerformer && (
        <Card className="border-emerald-500/30 bg-emerald-500/[0.03]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-emerald-600" />
              <CardTitle className="text-sm font-medium">
                Top performer
              </CardTitle>
            </div>
            <Badge
              variant="outline"
              className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            >
              {formatPercent(topPerformer.passed / topPerformer.completed)} pass
              rate
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            <TaskPromptBadge taskPromptId={topPerformer.taskPromptId} className="block">
              <p className="font-medium leading-tight cursor-pointer hover:underline">
                {truncateTask(topPerformer.task, 48)}
              </p>
            </TaskPromptBadge>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AgentBadge
                agentId={topPerformer.workerType}
                variant="badge"
                className="text-[10px]"
              />
              <span>
                {topPerformer.passed}/{topPerformer.completed} passed
              </span>
              {topPerformer.iterationStats && (
                <span>
                  · avg {formatNumber(topPerformer.iterationStats.mean)}{" "}
                  iterations
                </span>
              )}
            </div>
            <Link
              to={runsLinkFor(topPerformer)}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80"
            >
              View runs <ArrowRight className="h-3 w-3" />
            </Link>
          </CardContent>
        </Card>
      )}

      {needsAttention && needsAttention !== topPerformer && (
        <Card className="border-destructive/30 bg-destructive/[0.03]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <CardTitle className="text-sm font-medium">
                Needs attention
              </CardTitle>
            </div>
            <Badge
              variant="outline"
              className="border-destructive/40 bg-destructive/10 text-destructive"
            >
              {formatPercent(needsAttention.passed / needsAttention.completed)}{" "}
              pass rate
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            <TaskPromptBadge taskPromptId={needsAttention.taskPromptId} className="block">
              <p className="font-medium leading-tight cursor-pointer hover:underline">
                {truncateTask(needsAttention.task, 48)}
              </p>
            </TaskPromptBadge>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AgentBadge
                agentId={needsAttention.workerType}
                variant="badge"
                className="text-[10px]"
              />
              <span>
                {needsAttention.completed - needsAttention.passed}/
                {needsAttention.completed} failed
              </span>
            </div>
            <Link
              to={runsLinkFor(needsAttention, { outcome: "failed" })}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80"
            >
              View failed runs <ArrowRight className="h-3 w-3" />
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Performance breakdown (merged iteration + duration) ────────────────────

function PerformanceTable({ data }: { data: AnalysisResponse }) {
  const { groups } = data;

  if (groups.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Performance by task & worker
          </CardTitle>
          <CardDescription>No completed runs to analyze yet.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
            <Activity className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">
              Submit a run to start collecting benchmark data.
            </p>
            <Link to="/runs/new">
              <Button size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" /> Submit Run
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Sort by pass rate desc, then by completed desc (more reliable groups first)
  const sorted = [...groups].sort((a, b) => {
    const ra = a.completed > 0 ? a.passed / a.completed : -1;
    const rb = b.completed > 0 ? b.passed / b.completed : -1;
    if (rb !== ra) return rb - ra;
    return b.completed - a.completed;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Performance by task & worker
        </CardTitle>
        <CardDescription>
          Pass rate, iteration distribution, and run duration — sorted by pass
          rate.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[260px]">Task</TableHead>
              <TableHead>Worker</TableHead>
              <TableHead className="text-center">Runs</TableHead>
              <TableHead className="w-[200px]">Pass rate</TableHead>
              <TableHead className="text-center">Avg iter</TableHead>
              <TableHead className="text-center">Avg duration</TableHead>
              <TableHead className="w-[1%]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((group) => {
              const rate =
                group.completed > 0 ? group.passed / group.completed : 0;
              const failed = group.completed - group.passed;
              return (
                <TableRow key={getGroupKey(group)}>
                  <TableCell className="font-medium max-w-[260px] truncate">
                    <TaskPromptBadge
                      taskPromptId={group.taskPromptId}
                      className="block max-w-full truncate hover:underline"
                    >
                      <span className="cursor-pointer">{truncateTask(group.task, 36)}</span>
                    </TaskPromptBadge>
                  </TableCell>
                  <TableCell>
                    <AgentBadge agentId={group.workerType} variant="badge" />
                  </TableCell>
                  <TableCell className="text-center tabular-nums">
                    {group.completed}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-xs">
                        <span
                          className={cn(
                            "font-medium tabular-nums",
                            rate >= 0.8
                              ? "text-emerald-600 dark:text-emerald-400"
                              : rate >= 0.5
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-destructive",
                          )}
                        >
                          {formatPercent(rate)}
                        </span>
                        <span className="text-muted-foreground">
                          {group.passed}/{group.completed}
                        </span>
                      </div>
                      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        {group.passed > 0 && (
                          <div
                            className="h-full bg-emerald-500"
                            style={{
                              width: `${(group.passed / group.completed) * 100}%`,
                            }}
                          />
                        )}
                        {failed > 0 && (
                          <div
                            className="h-full bg-destructive"
                            style={{
                              width: `${(failed / group.completed) * 100}%`,
                            }}
                          />
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center font-mono tabular-nums text-xs">
                    {group.iterationStats ? (
                      <span
                        title={`min ${group.iterationStats.min} · max ${group.iterationStats.max} · σ ${formatNumber(group.iterationStats.stdDev)}`}
                      >
                        {formatNumber(group.iterationStats.mean)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center font-mono tabular-nums text-xs">
                    {group.durationStats ? (
                      <span
                        title={`min ${formatDuration(group.durationStats.min)} · max ${formatDuration(group.durationStats.max)} · σ ${formatDuration(group.durationStats.stdDev)}`}
                      >
                        {formatDuration(group.durationStats.mean)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link to={runsLinkFor(group)}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs"
                        title="View runs for this task / worker"
                      >
                        View <ArrowRight className="h-3 w-3" />
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ─── Pass@k table (env-gated) ───────────────────────────────────────────────

function PassAtKTable({ data }: { data: AnalysisResponse }) {
  const { groups, kValues } = data;
  if (groups.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pass@k by task & worker</CardTitle>
        <CardDescription>
          Probability of at least one correct solution in k attempts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="max-w-[200px]">Task</TableHead>
              <TableHead>Worker</TableHead>
              <TableHead className="text-center">Runs</TableHead>
              <TableHead className="text-center">Passed</TableHead>
              {kValues.map((k) => (
                <TableHead key={k} className="text-center">
                  pass@{k}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <TableRow key={getGroupKey(group)}>
                <TableCell className="font-medium max-w-[200px] truncate">
                  <TaskPromptBadge
                    taskPromptId={group.taskPromptId}
                    className="block max-w-full truncate hover:underline"
                  >
                    <span className="cursor-pointer">{truncateTask(group.task)}</span>
                  </TaskPromptBadge>
                </TableCell>
                <TableCell>
                  <AgentBadge agentId={group.workerType} variant="badge" />
                </TableCell>
                <TableCell className="text-center">{group.completed}</TableCell>
                <TableCell className="text-center">
                  <span
                    className={
                      group.passed > 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                    }
                  >
                    {group.passed}
                  </span>
                  {group.rejected > 0 && (
                    <span className="text-destructive ml-1">
                      / {group.rejected}
                    </span>
                  )}
                </TableCell>
                {kValues.map((k) => (
                  <TableCell key={k} className="text-center font-mono">
                    <span
                      className={
                        group.passAtK[k] >= 0.5
                          ? "text-emerald-600 dark:text-emerald-400"
                          : group.passAtK[k] > 0
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground"
                      }
                    >
                      {formatPercent(group.passAtK[k])}
                    </span>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ─── Success@≤T CDF chart (only when there is data) ────────────────────────

function SuccessAtTChart({
  data,
  agentNameById,
}: {
  data: AnalysisResponse;
  agentNameById: ReadonlyMap<string, string>;
}) {
  const { groups, maxT } = data;
  const groupsWithData = groups.filter((g) => g.passed > 0);
  if (groupsWithData.length === 0) return null;

  const chartData = Array.from({ length: maxT }, (_, i) => {
    const point: Record<string, number | string> = { iteration: i + 1 };
    for (const group of groupsWithData) {
      point[getGroupKey(group)] = group.successAtT[i] ?? 0;
    }
    return point;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Success@≤T (CDF)</CardTitle>
        <CardDescription>
          Probability of successful completion within T iterations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="iteration"
                label={{
                  value: "Iterations (T)",
                  position: "insideBottom",
                  offset: -5,
                }}
                tick={{ fontSize: 12 }}
              />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(v: number) => formatPercent(v)}
                tick={{ fontSize: 12 }}
                label={{
                  value: "P(success ≤ T)",
                  angle: -90,
                  position: "insideLeft",
                }}
              />
              <Tooltip
                formatter={(value: number) => formatPercent(value)}
                labelFormatter={(label: string | number) =>
                  `≤${label} iterations`
                }
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {groupsWithData.map((group, idx) => (
                <Line
                  key={getGroupKey(group)}
                  type="monotone"
                  dataKey={getGroupKey(group)}
                  name={`${group.task} (${agentNameById.get(group.workerType) ?? "Unknown agent"}) (n=${group.passed})`}
                  stroke={COLORS[idx % COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Loading skeleton ───────────────────────────────────────────────────────

function StatisticsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Empty state (zero runs) ────────────────────────────────────────────────

function ZeroRunsState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="rounded-full bg-primary/10 p-3">
          <BarChart3 className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-1">
          <h3 className="text-lg font-semibold">No benchmark data yet</h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            Submit your first benchmark run to start seeing pass rates,
            performance breakdowns, and insights here.
          </p>
        </div>
        <Link to="/runs/new">
          <Button size="lg" className="gap-2">
            <Plus className="h-4 w-4" /> Submit your first run
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function NoMatchingRunsState({
  criteriaCount,
  featureCount,
  onClear,
}: {
  criteriaCount: number;
  featureCount: number;
  onClear: () => void;
}) {
  const parts: string[] = [];
  if (criteriaCount > 0) {
    parts.push(
      `${criteriaCount} ${criteriaCount === 1 ? "criterion" : "criteria"}`,
    );
  }
  if (featureCount > 0) {
    parts.push(
      `${featureCount} ${featureCount === 1 ? "feature" : "features"}`,
    );
  }
  const filterDesc = parts.join(" and ") || "filters";
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="rounded-full bg-muted p-3">
          <FilterX className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h3 className="text-lg font-semibold">
            No runs match the selected filters
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            No benchmark runs match the selected {filterDesc}. Try removing some
            filters to broaden the results.
          </p>
        </div>
        <Button variant="outline" size="lg" className="gap-2" onClick={onClear}>
          <FilterX className="h-4 w-4" /> Clear filters
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function Statistics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { isFeatureEnabled } = useFeatureFlags();

  const selectedCriteria =
    searchParams.get("criteria")?.split(",").filter(Boolean) || [];
  const selectedFeatures =
    searchParams.get("features")?.split(",").filter(Boolean) || [];

  const { data, isLoading, isRefetching } = useQuery({
    queryKey: ["analysis", selectedCriteria, selectedFeatures],
    queryFn: () =>
      api.getAnalysis(
        [1, 2, 5],
        selectedCriteria.length > 0 ? selectedCriteria : undefined,
        selectedFeatures.length > 0 ? selectedFeatures : undefined,
      ),
    refetchInterval: 30_000,
  });
  const { data: agents = [] } = useQuery({
    queryKey: ["agents", "include-deleted"],
    queryFn: () => api.listAgents({ includeDeleted: true }),
    staleTime: 60_000,
  });
  const agentNameById = useMemo(
    () => new Map(agents.map((agent) => [agent._id, agent.name])),
    [agents],
  );

  const insights = useMemo(() => (data ? deriveInsights(data) : null), [data]);

  const handleToggleCriterion = (id: string) => {
    const newSelected = selectedCriteria.includes(id)
      ? selectedCriteria.filter((c) => c !== id)
      : [...selectedCriteria, id];

    if (newSelected.length === 0) {
      searchParams.delete("criteria");
    } else {
      searchParams.set("criteria", newSelected.join(","));
    }
    setSearchParams(searchParams, { replace: true });
  };

  const handleClearCriteria = () => {
    searchParams.delete("criteria");
    setSearchParams(searchParams, { replace: true });
  };

  const handleSelectAllCriteria = (ids: string[]) => {
    if (ids.length === 0) {
      searchParams.delete("criteria");
    } else {
      searchParams.set("criteria", ids.join(","));
    }
    setSearchParams(searchParams, { replace: true });
  };

  const handleToggleFeature = (id: string) => {
    const newSelected = selectedFeatures.includes(id)
      ? selectedFeatures.filter((f) => f !== id)
      : [...selectedFeatures, id];

    if (newSelected.length === 0) {
      searchParams.delete("features");
    } else {
      searchParams.set("features", newSelected.join(","));
    }
    setSearchParams(searchParams, { replace: true });
  };

  const handleClearFeatures = () => {
    searchParams.delete("features");
    setSearchParams(searchParams, { replace: true });
  };

  const handleSelectAllFeatures = (ids: string[]) => {
    if (ids.length === 0) {
      searchParams.delete("features");
    } else {
      searchParams.set("features", ids.join(","));
    }
    setSearchParams(searchParams, { replace: true });
  };

  const handleClearAllFilters = () => {
    searchParams.delete("criteria");
    searchParams.delete("features");
    setSearchParams(searchParams, { replace: true });
  };

  const hasData = !!data && data.summary.totalRuns > 0;
  const hasActiveFilter =
    selectedCriteria.length > 0 || selectedFeatures.length > 0;
  const activeFilterCount = selectedCriteria.length + selectedFeatures.length;
  const showPassAtK = import.meta.env.VITE_SHOW_PASS_AT_K === "true";

  // Foldable filters: collapse the card to reclaim vertical space. It is
  // folded by default to keep the KPIs above the fold; the open/closed state
  // is then persisted to localStorage so a user's preference sticks across
  // visits. When collapsed we still surface an "N active" badge so folding
  // never hides the fact that data is filtered.
  const FILTERS_OPEN_KEY = "scope:statistics:filters-open";
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(FILTERS_OPEN_KEY);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch {
      /* ignore */
    }
    return false;
  });
  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_OPEN_KEY, filtersOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [filtersOpen]);

  // Condensed filters: a single card holds both pickers side by side. Each
  // compact CriteriaFilterBar renders null when its option list is empty, so a
  // missing feature bar simply lets the criteria picker take the full width.
  const filterBars =
    data &&
    (data.availableCriteria.length > 0 || data.availableFeatures.length > 0) ? (
      <Card>
        <CardHeader className={cn(filtersOpen ? "pb-3" : "py-3")}>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={filtersOpen}
              aria-label={filtersOpen ? "Collapse filters" : "Expand filters"}
              className="group -ml-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
            >
              <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
              <CardTitle className="text-base">Filters</CardTitle>
              {!filtersOpen &&
                (activeFilterCount > 0 ? (
                  <Badge variant="secondary" className="ml-1 shrink-0">
                    {activeFilterCount} active
                  </Badge>
                ) : (
                  <span className="ml-1 truncate text-sm font-normal text-muted-foreground">
                    No filters applied
                  </span>
                ))}
            </button>
            <div className="flex shrink-0 items-center gap-3">
              {hasActiveFilter && (
                <button
                  onClick={handleClearAllFilters}
                  className="text-xs text-muted-foreground underline hover:text-foreground"
                >
                  Clear all
                </button>
              )}
              <button
                type="button"
                onClick={() => setFiltersOpen((v) => !v)}
                aria-expanded={filtersOpen}
                aria-label={filtersOpen ? "Collapse filters" : "Expand filters"}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {filtersOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                )}
              </button>
            </div>
          </div>
        </CardHeader>
        {filtersOpen && (
          <CardContent>
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {data.availableFeatures.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium">
                      Task prompt features
                    </span>
                    <HelpTooltip
                      docs="promptFeatures"
                      ariaLabel="About the task prompt feature filter"
                      text={
                        <>
                          Keep only runs whose task prompt was{" "}
                          <strong>detected</strong> to request every selected
                          feature (e.g. <code>asks_for_azure</code>). Adding
                          more features narrows the results (AND).
                        </>
                      }
                    />
                  </div>
                  <CriteriaFilterBar
                    compact
                    availableCriteria={data.availableFeatures}
                    selectedCriteria={selectedFeatures}
                    onToggle={handleToggleFeature}
                    onClear={handleClearFeatures}
                    onSelectAll={handleSelectAllFeatures}
                    itemLabel="features"
                  />
                </div>
              )}
              {data.availableCriteria.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium">
                      Requirements gate criteria
                    </span>
                    <HelpTooltip
                      docs="criteria"
                      ariaLabel="About the requirements gate criteria filter"
                      text={
                        <>
                          Keep only runs where <strong>every</strong> selected
                          success criterion passed. Adding more criteria narrows
                          the results (AND).
                        </>
                      }
                    />
                  </div>
                  <CriteriaFilterBar
                    compact
                    availableCriteria={data.availableCriteria}
                    selectedCriteria={selectedCriteria}
                    onToggle={handleToggleCriterion}
                    onClear={handleClearCriteria}
                    onSelectAll={handleSelectAllCriteria}
                    itemLabel="criteria"
                  />
                </div>
              )}
            </div>
          </CardContent>
        )}
      </Card>
    ) : null;

  return (
    <div className="space-y-6">
      {/* Page header with primary CTA */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Statistics</h1>
          <p className="text-muted-foreground">
            Pass rates, iteration distribution, and performance insights across
            your benchmark runs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isRefetching && (
            <span
              className="flex items-center gap-1 text-xs text-muted-foreground"
              aria-label="Refreshing"
            >
              <RefreshCw className="h-3 w-3 animate-spin" /> Refreshing
            </span>
          )}
        </div>
      </div>

      {!isLoading && data?.truncated && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span className="text-muted-foreground">
            Showing stats for the most recent{" "}
            <span className="font-medium text-foreground">
              {(data.runLimit ?? data.summary.totalRuns).toLocaleString()}
            </span>{" "}
            runs. Older runs are excluded to keep this page responsive — narrow the
            range with filters to analyze a specific slice.
          </span>
        </div>
      )}

      {isLoading || !data ? (
        <StatisticsSkeleton />
      ) : !hasData ? (
        hasActiveFilter &&
        (data.availableCriteria.length > 0 ||
          data.availableFeatures.length > 0) ? (
          <>
            {filterBars}
            <NoMatchingRunsState
              criteriaCount={selectedCriteria.length}
              featureCount={selectedFeatures.length}
              onClear={handleClearAllFilters}
            />
          </>
        ) : (
          <ZeroRunsState />
        )
      ) : (
        <>
          {/* Success Criteria + Task Prompt Feature filters */}
          {filterBars}

          {insights && <HeroKpis data={data} insights={insights} />}
          {insights && <InsightsRow insights={insights} />}

          <PerformanceTable data={data} />
          {isFeatureEnabled("statistics-graph") && (
            <SuccessAtTChart data={data} agentNameById={agentNameById} />
          )}
          {showPassAtK && <PassAtKTable data={data} />}
        </>
      )}
    </div>
  );
}
