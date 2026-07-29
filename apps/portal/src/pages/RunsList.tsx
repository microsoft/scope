// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useEffect, useCallback, Fragment, type Key, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useOutlet, useParams, useSearchParams } from "react-router-dom";
import { Trash2, Repeat, RotateCcw, Pause, Play, ChevronDown, ChevronRight, Apple, AppWindow, ArrowUpDown, FileText, Download, Lock, Eye } from "lucide-react";
import { FaLinux } from "react-icons/fa";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge, OutcomeBadge } from "@/components/StatusBadge";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,  DataTable,
  Pagination,
  BulkActionBar,
  CustomizeColumnsPanel,
  CustomizeColumnsLink,
  DateRangeFilter,
  useHiddenColumns,
  useColumnOrder,
  useListUrlState,
  usePersistentSort,
  initSortFromLocalStorage,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";
import { useShiftModifier } from "@/hooks/useShiftModifier";
import { CliCommand } from "@/components/CliCommand";
import { buildRunList, buildRunBulk } from "@/lib/cli/buildCommand";
import { useModelCapabilities, ModelSelectItems } from "@/components/ReasoningEffortSelect";
import { formatDate, formatId, formatDuration, truncate, cn } from "@/lib/utils";
import { WORKER_TYPES, STATUS_LIST, OUTCOME_LIST } from "@/types";
import type { Run, RunStatus, RunOutcome, IterationOp, BulkResubmitOverrides } from "@/types";

const FILTER_KEYS = ["worker", "status", "outcome", "taskPromptId", "submissionId", "criteria", "model", "profile", "os", "priority", "version", "dateFrom", "dateTo", "groupBy", "turns", "turnsOp", "maxIter", "maxIterOp"] as const;

/**
 * Describes how to fetch a given (1-based) page from the cursor-paginated
 * runs API. See cursorStack in RunsList for the full model.
 */
type RunsPageCursor =
  | { kind: "first" }
  | { kind: "after"; cursor: string }
  | { kind: "before"; cursor: string }
  | { kind: "last" };

/** Sentinel value used in multi-value filters to match rows missing the underlying field. */
const EMPTY_FILTER_VALUE = "__empty__";

/**
 * Helper for multi-value filter logic that supports the `EMPTY_FILTER_VALUE` sentinel.
 * Returns true if the row matches the current selection (either by explicit value or because
 * the row is missing the field and the sentinel is selected).
 */
function matchMultiValueFilter(selected: string[], rawValue: string | null | undefined): boolean {
  if (selected.length === 0) return true;
  const wantsEmpty = selected.includes(EMPTY_FILTER_VALUE);
  const explicit = selected.filter((v) => v !== EMPTY_FILTER_VALUE);
  if (!rawValue) return wantsEmpty;
  if (explicit.length === 0) return false; // only "(Unknown)" selected and row has a value
  return explicit.includes(rawValue);
}

/** Compact inline badges with overflow (+N) dropdown for dense table cells. */
function OverflowBadges({
  items,
  max = 1,
  renderItem,
  renderMenuItem,
}: {
  items: string[];
  max?: number;
  renderItem: (item: string) => ReactNode;
  renderMenuItem: (item: string) => ReactNode;
}) {
  const visible = items.slice(0, max);
  const hidden = items.slice(max);
  return (
    <div className="flex min-w-0 items-center gap-1">
      {visible.map((item) => renderItem(item))}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-mono bg-muted hover:bg-accent transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              +{hidden.length}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
            {hidden.map((item) => renderMenuItem(item))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Small OS-platform icon. Falls back to a text badge for unknown platforms. */
function OsPlatformIcon({ platform }: { platform: string }) {
  const p = platform.toLowerCase();
  const Icon = p === "darwin" || p === "macos"
    ? Apple
    : p === "win32" || p === "windows"
      ? AppWindow
      : p === "linux"
        ? FaLinux
        : null;
  const label = p === "darwin" || p === "macos"
    ? "macOS"
    : p === "win32" || p === "windows"
      ? "Windows"
      : p === "linux"
        ? "Linux"
        : platform;
  if (!Icon) {
    return (
      <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono">
        {platform}
      </Badge>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground">
          <Icon className="h-3.5 w-3.5" aria-label={label} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Aggregate progress bar used in grouped rows for the Status and Outcome
 * columns. Shows `count/total label` with three explicit segments:
 *   - success (green or red, depending on tone)
 *   - failed (always red, if any)
 *   - pending remainder (gray) — anything not yet in a terminal state
 */
function AggregateProgress({
  count,
  failedCount = 0,
  total,
  label,
  tone,
  pendingLabel = "pending",
}: {
  count: number;
  /** Optional failed count rendered as a red segment alongside the success segment. */
  failedCount?: number;
  total: number;
  label: string;
  tone: "success" | "destructive";
  /** Tooltip label for the gray remainder (default "pending"). */
  pendingLabel?: string;
}) {
  if (total === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const pendingCount = Math.max(0, total - count - failedCount);
  const successPct = (count / total) * 100;
  const failedPct = (failedCount / total) * 100;
  const pendingPct = (pendingCount / total) * 100;
  const successClass = tone === "success" ? "bg-emerald-500" : "bg-destructive";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex min-w-0 flex-col gap-1 cursor-default">
          <span className="text-xs font-medium">
            {count}/{total} {label}
          </span>
          <div className="flex h-1 w-full overflow-hidden rounded-full bg-muted">
            {successPct > 0 && (
              <div className={cn("h-full transition-all", successClass)} style={{ width: `${successPct}%` }} />
            )}
            {failedPct > 0 && (
              <div className="h-full bg-destructive transition-all" style={{ width: `${failedPct}%` }} />
            )}
            {pendingPct > 0 && (
              <div
                className="h-full bg-muted-foreground/30 transition-all"
                style={{ width: `${pendingPct}%` }}
              />
            )}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("h-2 w-2 rounded-sm", successClass)} />
            <span className="text-muted-foreground">{label}</span>
          </span>
          <span className="text-right">{count}</span>
          {failedCount > 0 && (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm bg-destructive" />
                <span className="text-muted-foreground">failed</span>
              </span>
              <span className="text-right">{failedCount}</span>
            </>
          )}
          {pendingCount > 0 && (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm bg-muted-foreground/40" />
                <span className="text-muted-foreground">{pendingLabel}</span>
              </span>
              <span className="text-right">{pendingCount}</span>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// All toggleable columns rendered by the customize-columns panel and the
// DataTable. Lifted to module scope so its identity is stable across renders
// (used as a dependency by useColumnOrder via the column-id signature).
const COLUMN_OPTIONS: CustomizeColumnsOption[] = [
  { id: "id", label: "ID", required: true },
  { id: "submission", label: "Submission" },
  { id: "task", label: "Task" },
  { id: "criteria", label: "Criteria" },
  { id: "worker", label: "Worker" },
  { id: "model", label: "Model" },
  { id: "effort", label: "Effort" },
  { id: "version", label: "Version" },
  { id: "os", label: "OS" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
  { id: "profile", label: "Profile" },
  { id: "priority", label: "Priority" },
  { id: "status", label: "Status" },
  { id: "outcome", label: "Outcome" },
  { id: "report", label: "Report" },
  { id: "attempt", label: "Attempt" },
  { id: "turns", label: "Turns" },
  { id: "llmCalls", label: "LLM Calls" },
  { id: "duration", label: "Duration" },
  { id: "tokens", label: "Tokens" },
  { id: "created", label: "Created" },
];
const COLUMN_IDS = COLUMN_OPTIONS.map((o) => o.id);

// Segmented toggle used in the list header for the Group By control. Kept
// inline because it is only used here.
const GROUP_BY_OPTIONS: ReadonlyArray<{ value: "profile" | "task" | "submissionId"; label: string }> = [
  { value: "profile", label: "Profile" },
  { value: "task", label: "Task" },
  { value: "submissionId", label: "Submission" },
];

function GroupByToggle({
  value,
  onChange,
}: {
  value: "none" | "profile" | "task" | "submissionId";
  onChange: (next: "none" | "profile" | "task" | "submissionId") => void;
}) {
  return (
    <div
      role="group"
      aria-label="Group runs by"
      className="hidden sm:inline-flex h-8 items-center rounded-md border border-border/60 bg-card p-0.5"
    >
      <span className="px-2 text-xs font-medium text-muted-foreground">Group by</span>
      {GROUP_BY_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? "none" : opt.value)}
            className={
              "h-7 rounded-sm px-2.5 text-xs font-medium transition-colors " +
              (active
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// Sidebar filter widget: pick a comparator (≥ / ≤ / =) and a numeric value.
// Clearing the input clears both the value and the op from the URL. Used for
// the Turns and Max iterations filters; mirrors the API contract that accepts
// `{turns, turnsOp}` / `{maxIterations, maxIterationsOp}` with op ∈ eq|gte|lte.
const NUMERIC_OPS: ReadonlyArray<{ value: IterationOp; label: string; aria: string }> = [
  { value: "gte", label: "≥", aria: "greater than or equal to" },
  { value: "lte", label: "≤", aria: "less than or equal to" },
  { value: "eq", label: "=", aria: "equal to" },
];

function NumericComparatorRow({
  label,
  ariaLabel,
  op,
  value,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  op: IterationOp;
  value: string;
  onChange: (next: { op: IterationOp; value: string }) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <Select value={op} onValueChange={(v) => onChange({ op: v as IterationOp, value })}>
        <SelectTrigger
          aria-label={`${ariaLabel} comparator`}
          className="h-8 w-16 px-2 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {NUMERIC_OPS.map((o) => (
            <SelectItem key={o.value} value={o.value} aria-label={o.aria}>
              <span className="font-mono">{o.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        placeholder="any"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => {
          const raw = e.target.value;
          // Allow empty (clears) or non-negative integers only.
          if (raw === "") {
            onChange({ op, value: "" });
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) return;
          onChange({ op, value: String(Math.floor(n)) });
        }}
        className="h-8 flex-1 text-xs"
      />
    </div>
  );
}

export function RunsList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const isForceRetryModifierActive = useShiftModifier();

  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });

  // Initialize sort preference from localStorage if no sort params in URL
  useEffect(() => {
    initSortFromLocalStorage(state, "runs");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist sort preference to localStorage
  usePersistentSort(state, { pageKey: "runs" });

  // Column visibility — persisted under scope:hidden-columns:runs:v2.
  // The `:v2` suffix forces the new default set to apply for users who had
  // an older preference stored under the unversioned key.
  // Default visible: ID, Submission, Task, Criteria, Worker, Version, OS, MCP,
  // Skills, Extensions, Profile, Priority, Status, Outcome.
  // Hidden by default (opt-in via Customize columns): Report, Attempt,
  // Turns, LLM Calls, Duration, Tokens, Created. Model is shown next to
  // Worker so users can see what model each run used at a glance.
  const columnVisibility = useHiddenColumns({
    storageKey: "runs:v2",
    defaultHidden: [
      "report",
      "attempt",
      "turns",
      "llmCalls",
      "duration",
      "tokens",
      "created",
    ],
  });
  // Persisted column order (matches the customize panel). The `id` column is
  // marked `required` in COLUMN_OPTIONS and is locked from reordering by the
  // panel; `actions` lives outside COLUMN_OPTIONS and is always pinned right.
  const columnOrder = useColumnOrder({
    storageKey: "runs:v2",
    columnIds: COLUMN_IDS,
  });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(new Set());
  
  // Get groupBy from URL state
  const groupBy = (state.getFilter("groupBy") ?? "none") as "none" | "profile" | "task" | "submissionId";

  // Cursor pagination — keep a stack of cursors that map a virtual page number
  // to a fetch instruction. Each entry describes how to fetch that page:
  //   { kind: "first" }                — page 1, no cursor (uses defaults)
  //   { kind: "after",  cursor: "..." } — page reached by going forward (after)
  //   { kind: "before", cursor: "..." } — page reached by going backward (before)
  //   { kind: "last" }                  — fetched via server-side `last=true`
  // This supports first/last buttons even though the underlying API is cursor
  // based: "Last" sets {kind:"last"} at the target page; "Prev" from there uses
  // `cursors.prev` returned with each response to walk backwards.
  const [cursorStack, setCursorStack] = useState<RunsPageCursor[]>([{ kind: "first" }]);

  // Multi-selection state — preserved while the user navigates pages.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [priorityDialogOpen, setPriorityDialogOpen] = useState(false);
  const [bulkPriorityValue, setBulkPriorityValue] = useState<number>(0);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [resubmitDialogOpen, setResubmitDialogOpen] = useState(false);
  const [resubmitCount, setResubmitCount] = useState<number>(1);
  const [resubmitOverrides, setResubmitOverrides] = useState<BulkResubmitOverrides>({});

  // Reset stack whenever filters or page size change.
  const filtersKey = useMemo(
    () =>
      JSON.stringify({
        search: state.search,
        worker: state.getFilterList("worker"),
        status: state.getFilterList("status"),
        outcome: state.getFilterList("outcome"),
        taskPromptId: state.getFilter("taskPromptId"),
        submissionId: state.getFilter("submissionId"),
        criteria: state.getFilter("criteria"),
        model: state.getFilterList("model"),
        profile: state.getFilterList("profile"),
        os: state.getFilterList("os"),
        priority: state.getFilterList("priority"),
        version: state.getFilterList("version"),
        dateFrom: state.getFilter("dateFrom"),
        dateTo: state.getFilter("dateTo"),
        turns: state.getFilter("turns"),
        turnsOp: state.getFilter("turnsOp"),
        maxIter: state.getFilter("maxIter"),
        maxIterOp: state.getFilter("maxIterOp"),
        groupBy: state.getFilter("groupBy"),
        pageSize: state.pageSize,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.search,
      state.pageSize,
      searchParams.toString(),
    ],
  );
  useEffect(() => {
    setCursorStack([{ kind: "first" }]);
    setSelectedIds(new Set());
    if (state.page !== 1) state.setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  useEffect(() => {
    setExpandedGroupKeys(new Set());
  }, [groupBy, filtersKey, state.page]);

  const workers = state.getFilterList("worker");
  const statuses = state.getFilterList("status");
  const outcomes = state.getFilterList("outcome");
  const models = state.getFilterList("model");
  const profiles = state.getFilterList("profile");
  const osList = state.getFilterList("os");
  const priorities = state.getFilterList("priority");
  const versions = state.getFilterList("version");
  const taskPromptId = state.getFilter("taskPromptId") ?? undefined;
  const submissionId = state.getFilter("submissionId") ?? undefined;
  const criteria = state.getFilter("criteria") ?? undefined;
  const dateFrom = state.getFilter("dateFrom");
  const dateTo = state.getFilter("dateTo");

  // Numeric comparator filters: only sent to the API when value is set.
  // `*Op` defaults to "gte" (≥) so a value alone yields the most common "at
  // least N" semantic without forcing the user to pick an operator first.
  const turnsRaw = state.getFilter("turns") ?? "";
  const turnsOp = ((state.getFilter("turnsOp") as IterationOp | null) ?? "gte") as IterationOp;
  const maxIterRaw = state.getFilter("maxIter") ?? "";
  const maxIterOp = ((state.getFilter("maxIterOp") as IterationOp | null) ?? "gte") as IterationOp;
  const turnsValue = turnsRaw === "" ? undefined : Number(turnsRaw);
  const maxIterValue = maxIterRaw === "" ? undefined : Number(maxIterRaw);
  // Equivalent CLI for the current bulk selection. We surface `delete` (the
  // canonical destructive bulk op) and note that retry/cancel/download follow
  // the same id-list pattern.
  const bulkCli = useMemo(() => {
    const ids = [...selectedIds];
    const cmd = buildRunBulk("delete", ids);
    return {
      ...cmd,
      notes: [
        ...cmd.notes,
        "Swap `delete` for `cancel`, `retry`, or `download` to apply other bulk actions to the same runs.",
      ],
    };
  }, [selectedIds]);
  // The CLI only supports a subset of the Portal's filters, so anything it
  // can't express is surfaced as a note rather than silently dropped.
  const runListCli = useMemo(() => {
    const unsupported: string[] = [];
    if (state.search) unsupported.push("text search");
    if (workers.length > 1) unsupported.push("worker (multiple)");
    if (statuses.length > 0) unsupported.push("status");
    if (outcomes.length > 0) unsupported.push("outcome");
    if (taskPromptId) unsupported.push("task");
    if (criteria) unsupported.push("criteria");
    if (models.length > 0) unsupported.push("model");
    if (profiles.length > 0) unsupported.push("profile");
    if (osList.length > 0) unsupported.push("OS");
    if (priorities.length > 0) unsupported.push("priority");
    if (versions.length > 0) unsupported.push("version");
    if (dateFrom || dateTo) unsupported.push("date range");
    return buildRunList({
      worker: workers.length === 1 ? workers[0] : undefined,
      submissionId,
      turns: turnsRaw || undefined,
      turnsOp,
      maxIter: maxIterRaw || undefined,
      maxIterOp,
      unsupportedFilters: unsupported,
    });
  }, [
    state.search, workers, statuses, outcomes, taskPromptId, criteria, models,
    profiles, osList, priorities, versions, dateFrom, dateTo, submissionId,
    turnsRaw, turnsOp, maxIterRaw, maxIterOp,
  ]);

  const currentCursor: RunsPageCursor = cursorStack[state.page - 1] ?? { kind: "first" };

  // The server only accepts a single explicit value per filter; if multiple values
  // are selected or the special `(Unknown)` sentinel is selected, we fetch the
  // broader set and filter client-side.
  const singleServerValue = (vals: string[]): string | undefined =>
    vals.length === 1 && vals[0] !== EMPTY_FILTER_VALUE ? vals[0] : undefined;
  const serverWorker = singleServerValue(workers);
  const serverStatus = singleServerValue(statuses);
  const serverOutcome = singleServerValue(outcomes);
  const serverProfile = singleServerValue(profiles);

  // Serialize cursor into a stable string for the query key.
  const cursorKey =
    currentCursor.kind === "first" || currentCursor.kind === "last"
      ? currentCursor.kind
      : `${currentCursor.kind}:${currentCursor.cursor}`;

  const { data: runsResponse, isLoading, isRefetching } = useQuery({
    queryKey: ["runs", serverWorker, serverStatus, serverOutcome, taskPromptId, submissionId, criteria, serverProfile, turnsValue, turnsOp, maxIterValue, maxIterOp, state.pageSize, cursorKey],
    queryFn: () =>
      api.listRuns({
        worker: serverWorker,
        status: serverStatus,
        outcome: serverOutcome,
        taskPromptId,
        submissionId,
        criteria,
        profileId: serverProfile,
        turns: turnsValue,
        turnsOp: turnsValue !== undefined ? turnsOp : undefined,
        maxIterations: maxIterValue,
        maxIterationsOp: maxIterValue !== undefined ? maxIterOp : undefined,
        limit: state.pageSize,
        after: currentCursor.kind === "after" ? currentCursor.cursor : undefined,
        before: currentCursor.kind === "before" ? currentCursor.cursor : undefined,
        last: currentCursor.kind === "last" ? true : undefined,
      }),
    refetchInterval: 10_000,
  });
  const { data: profilesData } = useQuery({
    queryKey: ["profiles", "runs-list-grouping"],
    queryFn: () => api.listProfiles(),
    staleTime: 60_000,
  });
  // Lazy queries for the resubmit override dialog.
  const { data: agentsData = [] } = useQuery({
    queryKey: ["agents", "runs-list-resubmit"],
    queryFn: () => api.listAgents(),
    enabled: resubmitDialogOpen,
    staleTime: 60_000,
  });
  const { data: mcpServersData = [] } = useQuery({
    queryKey: ["mcp-servers", "runs-list-resubmit"],
    queryFn: () => api.listMcpServers(),
    enabled: resubmitDialogOpen,
    staleTime: 60_000,
  });

  const allRuns = runsResponse?.data ?? [];
  const cursors = runsResponse?.cursors ?? { next: null, prev: null };
  const estimatedTotal = runsResponse?.estimatedTotal;
  const profileNameById = useMemo(
    () => new Map((profilesData ?? []).map((profile) => [profile._id, profile.name])),
    [profilesData],
  );

  // Client-side filtering for multi-value selections + search.
  const filteredRuns = useMemo(() => {
    const q = state.search.trim().toLowerCase();
    return allRuns.filter((r) => {
      // Run client-side filter for worker/status/outcome whenever the server-side
      // filter can't fully express the selection (multi-value or `(Unknown)`).
      if (workers.length > 0 && !serverWorker && !matchMultiValueFilter(workers, r.workerType)) return false;
      if (statuses.length > 0 && !serverStatus && !matchMultiValueFilter(statuses, r.run?.status)) return false;
      if (outcomes.length > 0 && !serverOutcome && !matchMultiValueFilter(outcomes, r.run?.outcome)) return false;
      // Profile is also server-narrowed when a single non-sentinel is selected.
      if (profiles.length > 0 && !serverProfile && !matchMultiValueFilter(profiles, r.profileId)) return false;
      if (!matchMultiValueFilter(models, r.model)) return false;
      if (!matchMultiValueFilter(osList, r.run?.os?.platform)) return false;
      if (!matchMultiValueFilter(priorities, r.priority != null ? String(r.priority) : null)) return false;
      if (!matchMultiValueFilter(versions, r.agentVersion)) return false;
      if (dateFrom || dateTo) {
        const ts = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
        if (Number.isNaN(ts)) return false;
        if (dateFrom) {
          const fromTs = Date.parse(`${dateFrom}T00:00:00`);
          if (!Number.isNaN(fromTs) && ts < fromTs) return false;
        }
        if (dateTo) {
          const toTs = Date.parse(`${dateTo}T00:00:00`);
          if (!Number.isNaN(toTs) && ts >= toTs + 86_400_000) return false;
        }
      }
      if (q) {
        const hay =
          (r._id + " " + (r.scenario?.task ?? "") + " " + (r.model ?? "") + " " + (r.workerType ?? "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allRuns, workers, statuses, outcomes, models, profiles, osList, priorities, versions, dateFrom, dateTo, serverWorker, serverStatus, serverOutcome, serverProfile, state.search]);

  const sortedRuns = useMemo(() => {
    if (!state.sort) return filteredRuns;
    const out = [...filteredRuns];
    out.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") out.reverse();
    return out;
  }, [filteredRuns, state.sort, state.sortDir]);

  // Group runs by the selected groupBy option
  const groupedAndDisplayedRuns = useMemo(() => {
    if (groupBy === "none") return sortedRuns;
    
    const groups = new Map<string, Run[]>();
    for (const run of sortedRuns) {
      let key = "";
      switch (groupBy) {
        case "profile":
          key = run.profileId ?? "(No Profile)";
          break;
        case "task":
          key = run.scenario?.task ?? "(No Task)";
          break;
        case "submissionId":
          key = run.submissionId ?? "(No Submission)";
          break;
      }
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(run);
    }
    return Array.from(groups.entries()).map(([groupKey, runs]) => ({
      groupKey,
      runs,
    }));
  }, [sortedRuns, groupBy]);
  const groupedRuns = useMemo(
    () => (groupBy === "none" ? [] : (groupedAndDisplayedRuns as Array<{ groupKey: string; runs: Run[] }>)),
    [groupBy, groupedAndDisplayedRuns],
  );
  const groupedTableItems = useMemo(
    () => groupedRuns.flatMap(({ runs }) => runs),
    [groupedRuns],
  );

  const totalPages = useMemo(() => {
    if (estimatedTotal == null) return undefined;
    return Math.max(1, Math.ceil(estimatedTotal / state.pageSize));
  }, [estimatedTotal, state.pageSize]);

  const handlePageChange = useCallback(
    (next: number) => {
      if (next === state.page) return;

      // FIRST page — always available, no cursor.
      if (next === 1) {
        setCursorStack((prev) => {
          const copy = [...prev];
          copy[0] = { kind: "first" };
          return copy;
        });
        state.setPage(1);
        return;
      }

      // LAST page — use server `last=true` to fetch the tail in O(n).
      if (totalPages != null && next === totalPages) {
        setCursorStack((prev) => {
          const copy = [...prev];
          copy[next - 1] = { kind: "last" };
          return copy;
        });
        state.setPage(next);
        return;
      }

      // NEXT — forward one page using `cursors.next` from current response.
      if (next === state.page + 1) {
        if (!cursors.next) return;
        setCursorStack((prev) => {
          const copy = [...prev];
          copy[next - 1] = { kind: "after", cursor: cursors.next! };
          return copy;
        });
        state.setPage(next);
        return;
      }

      // PREV — backward one page. If we already have a cursor for the target
      // page (we walked forward to get here), reuse it. Otherwise use the
      // current response's `cursors.prev` to walk backwards from a `last` jump.
      if (next === state.page - 1) {
        const existing = cursorStack[next - 1];
        if (!existing) {
          if (!cursors.prev) return;
          setCursorStack((prev) => {
            const copy = [...prev];
            copy[next - 1] = { kind: "before", cursor: cursors.prev! };
            return copy;
          });
        }
        state.setPage(next);
        return;
      }
    },
    [state, cursors.next, cursors.prev, cursorStack, totalPages],
  );

  // ---- Bulk action mutations ----
  const invalidateRuns = () => queryClient.invalidateQueries({ queryKey: ["runs"] });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteRuns(ids),
    onSuccess: (res) => {
      toast.success(`Deleted ${res.deleted} run${res.deleted !== 1 ? "s" : ""}`);
      setSelectedIds(new Set());
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const bulkRetryMutation = useMutation({
    mutationFn: ({ ids, force }: { ids: string[]; force?: boolean }) =>
      api.bulkRetryRuns(ids, { force }),
    onSuccess: (res) => {
      toast.success(`Retried ${res.retried} run${res.retried !== 1 ? "s" : ""}${res.skipped ? `, skipped ${res.skipped}` : ""}`);
      setSelectedIds(new Set());
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to retry: ${err.message}`),
  });

  const bulkResubmitMutation = useMutation({
    mutationFn: ({ ids, count, overrides }: { ids: string[]; count?: number; overrides?: BulkResubmitOverrides }) =>
      api.bulkResubmitRuns(ids, count ?? 1, overrides && Object.keys(overrides).length > 0 ? overrides : undefined),
    onSuccess: (res) => {
      toast.success(`Resubmitted ${res.submitted} run${res.submitted !== 1 ? "s" : ""}${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      setSelectedIds(new Set());
      setResubmitDialogOpen(false);
      setResubmitCount(1);
      setResubmitOverrides({});
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to resubmit: ${err.message}`),
  });

  const bulkPauseMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkPauseRuns(ids),
    onSuccess: (res) => {
      toast.success(`Paused ${res.paused} run${res.paused !== 1 ? "s" : ""}${res.skipped ? `, skipped ${res.skipped}` : ""}`);
      setSelectedIds(new Set());
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to pause: ${err.message}`),
  });

  const bulkResumeMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkResumeRuns(ids),
    onSuccess: (res) => {
      toast.success(`Resumed ${res.resumed} run${res.resumed !== 1 ? "s" : ""}${res.skipped ? `, skipped ${res.skipped}` : ""}`);
      setSelectedIds(new Set());
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to resume: ${err.message}`),
  });

  const bulkSetPriorityMutation = useMutation({
    mutationFn: ({ ids, priority }: { ids: string[]; priority: number }) =>
      api.bulkSetPriority(ids, priority),
    onSuccess: (res, vars) => {
      toast.success(`Priority updated for ${res.updated} run${res.updated !== 1 ? "s" : ""} (→ ${vars.priority})`);
      setSelectedIds(new Set());
      setPriorityDialogOpen(false);
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to set priority: ${err.message}`),
  });

  const bulkReportMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkTriggerReports(ids),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["report-statuses"] });
      toast.success(`Queued ${res.created} report${res.created !== 1 ? "s" : ""} for generation${res.notFound.length ? `, ${res.notFound.length} not found` : ""}`);
      setSelectedIds(new Set());
      setReportDialogOpen(false);
    },
    onError: (err: Error) => toast.error(`Failed to generate reports: ${err.message}`),
  });

  const batchDownloadMutation = useMutation({
    mutationFn: (ids: string[]) => api.batchArchive(ids),
    onSuccess: (_, ids) => {
      toast.success(`Downloading ${ids.length} run${ids.length !== 1 ? "s" : ""} as archive`);
    },
    onError: (err: Error) => toast.error(`Failed to download archive: ${err.message}`),
  });

  // ---- Selection helpers ----
  const toggleRowSelection = useCallback((id: Key) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAllSelection = useCallback((allIds: Key[]) => {
    setSelectedIds((prev) => {
      const stringIds = allIds.map((id) => String(id));
      const allSelected = stringIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        for (const id of stringIds) next.delete(id);
      } else {
        for (const id of stringIds) next.add(id);
      }
      return next;
    });
  }, []);

  const toggleGroupExpansion = useCallback((groupKey: string) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const selectedRunsList = useMemo(
    () => allRuns.filter((r) => selectedIds.has(r._id)),
    [allRuns, selectedIds],
  );

  // Capability counts so action buttons can disable cleanly.
  const selectionCaps = useMemo(() => {
    let retryable = 0;
    let pausable = 0;
    let resumable = 0;
    let prioritizable = 0;
    for (const r of selectedRunsList) {
      const s = r.run?.status;
      if (s === "done") retryable += 1;
      if (s === "pending" || s === "queued" || s === "processing") pausable += 1;
      if (s === "paused") resumable += 1;
      if (s === "pending" || s === "queued" || s === "paused") prioritizable += 1;
    }
    return { retryable, pausable, resumable, prioritizable };
  }, [selectedRunsList]);

  // ─── Resubmit-dialog derived state ──────────────────────────────────────
  // Build a summary of the selected runs: collapses to a single value when
  // all rows agree, exposes `isMulti*` flags so the dialog can show
  // "Mixed (keep each)" placeholders.
  const selectedRunsSummary = useMemo(() => {
    const sel = selectedRunsList;
    if (sel.length === 0) {
      return {
        worker: null as string | null,
        model: null as string | null,
        reasoningEffort: null as string | null,
        maxIterations: null as number | null,
        mcpServers: null as string[] | null,
        skillRevisions: null as string[] | null,
        extensions: null as string[] | null,
        profileId: null as string | null,
        profileVersion: null as number | null,
        isMultiWorker: false,
        isMultiModel: false,
        isMultiEffort: false,
        isMultiIterations: false,
        isMultiMcp: false,
        isMultiSkills: false,
        isMultiExtensions: false,
        isMultiProfile: false,
      };
    }
    const uniq = <T,>(xs: T[]) => [...new Set(xs)];
    const join = (xs?: string[]) => (xs ?? []).slice().sort().join(",");
    const workers = uniq(sel.map((r) => r.workerType));
    const models = uniq(sel.map((r) => r.model ?? ""));
    const efforts = uniq(sel.map((r) => r.reasoningEffort ?? ""));
    const iterations = uniq(sel.map((r) => r.maxIterations ?? 0));
    const mcpJoined = uniq(sel.map((r) => join(r.mcpServers)));
    const skillsJoined = uniq(sel.map((r) => join(r.skillRevisions)));
    const extsJoined = uniq(sel.map((r) => join(r.extensions)));
    const profileIds = uniq(sel.map((r) => r.profileId ?? ""));
    const profileVersions = uniq(sel.map((r) => parseProfileVersion(r.profileVersionId) ?? 0));
    return {
      worker: workers.length === 1 ? workers[0] : null,
      model: models.length === 1 ? (models[0] || null) : null,
      reasoningEffort: efforts.length === 1 ? (efforts[0] || null) : null,
      maxIterations: iterations.length === 1 ? (iterations[0] || null) : null,
      mcpServers: mcpJoined.length === 1 ? (sel[0].mcpServers ?? []) : null,
      skillRevisions: skillsJoined.length === 1 ? (sel[0].skillRevisions ?? []) : null,
      extensions: extsJoined.length === 1 ? (sel[0].extensions ?? []) : null,
      profileId: profileIds.length === 1 ? (profileIds[0] || null) : null,
      profileVersion: profileVersions.length === 1 ? (profileVersions[0] || null) : null,
      isMultiWorker: workers.length > 1,
      isMultiModel: models.length > 1,
      isMultiEffort: efforts.length > 1,
      isMultiIterations: iterations.length > 1,
      isMultiMcp: mcpJoined.length > 1,
      isMultiSkills: skillsJoined.length > 1,
      isMultiExtensions: extsJoined.length > 1,
      isMultiProfile: profileIds.length > 1,
    };
  }, [selectedRunsList]);

  // Profile active for the resubmit dialog.
  // undefined = keep from source; null = detach; string = a specific profileId.
  const activeProfileId = resubmitOverrides.profileId !== undefined
    ? resubmitOverrides.profileId
    : selectedRunsSummary.profileId;
  const activeProfile = useMemo(
    () => (activeProfileId
      ? (profilesData ?? []).find((p) => p._id === activeProfileId) ?? null
      : null),
    [profilesData, activeProfileId],
  );

  const availableAgents = useMemo(
    () => agentsData.filter((a) => !a.deletedAt && a.available !== false),
    [agentsData],
  );

  // When a profile is active, its values take precedence.
  const effectiveWorker = activeProfile
    ? activeProfile.version.workerType
    : (resubmitOverrides.workerType ?? selectedRunsSummary.worker);
  const effectiveAgent = useMemo(
    () => availableAgents.find((a) => a._id === effectiveWorker),
    [availableAgents, effectiveWorker],
  );
  const availableModels = effectiveAgent?.supportedModels ?? [];

  // Effort-aware model capabilities for the dialog.
  const { capabilitiesMap: resubmitCapabilitiesMap } = useModelCapabilities(effectiveWorker || undefined);
  const effectiveModel = activeProfile
    ? activeProfile.version.model
    : (resubmitOverrides.model ?? selectedRunsSummary.model);
  const resubmitSupportedEfforts = effectiveModel
    ? (resubmitCapabilitiesMap.get(effectiveModel)?.reasoningEffort ?? [])
    : [];

  // Auto-clear/auto-select effort when the effective model changes.
  useEffect(() => {
    if (!resubmitDialogOpen) return;
    const current = resubmitOverrides.reasoningEffort;
    if (resubmitSupportedEfforts.length === 1) {
      if (current !== resubmitSupportedEfforts[0]) {
        setResubmitOverrides((prev) => ({ ...prev, reasoningEffort: resubmitSupportedEfforts[0] }));
      }
    } else if (current && current !== null) {
      if (resubmitSupportedEfforts.length === 0 || !resubmitSupportedEfforts.includes(current)) {
        setResubmitOverrides((prev) => {
          const next = { ...prev };
          delete next.reasoningEffort;
          return next;
        });
      }
    }
  }, [effectiveModel, resubmitSupportedEfforts, resubmitDialogOpen, resubmitOverrides.reasoningEffort]);

  const isBusy =
    bulkDeleteMutation.isPending ||
    bulkRetryMutation.isPending ||
    bulkResubmitMutation.isPending ||
    bulkPauseMutation.isPending ||
    bulkResumeMutation.isPending ||
    bulkSetPriorityMutation.isPending ||
    bulkReportMutation.isPending ||
    batchDownloadMutation.isPending;

  const handleBulkRetry = useCallback(() => {
    if (selectedIds.size === 0) return;
    bulkRetryMutation.mutate({ ids: [...selectedIds], force: isForceRetryModifierActive });
  }, [bulkRetryMutation, selectedIds, isForceRetryModifierActive]);

  // Bulk re-submit: opens the override dialog (count + per-field overrides).
  // The dialog then triggers bulkResubmitMutation with the user's choices.
  const openResubmitDialog = useCallback(() => {
    if (selectedIds.size === 0) return;
    setResubmitCount(1);
    setResubmitOverrides({});
    setResubmitDialogOpen(true);
  }, [selectedIds.size]);

  // Single-row resubmit (kebab menu / row action) — keeps the simple one-click flow.
  const handleSingleRowResubmit = useCallback(
    (id: string) => {
      bulkResubmitMutation.mutate({ ids: [id], count: 1 });
    },
    [bulkResubmitMutation],
  );

  const handleBulkPause = useCallback(() => {
    if (selectionCaps.pausable === 0) return;
    bulkPauseMutation.mutate([...selectedIds]);
  }, [bulkPauseMutation, selectedIds, selectionCaps.pausable]);

  const handleBulkResume = useCallback(() => {
    if (selectionCaps.resumable === 0) return;
    bulkResumeMutation.mutate([...selectedIds]);
  }, [bulkResumeMutation, selectedIds, selectionCaps.resumable]);

  const openPriorityDialog = useCallback(() => {
    if (selectionCaps.prioritizable === 0) return;
    // Pre-fill with the common priority across prioritizable selections.
    const eligible = selectedRunsList.filter((r) => {
      const s = r.run?.status;
      return s === "pending" || s === "queued" || s === "paused";
    });
    const priorities = new Set(eligible.map((r) => r.priority ?? 0));
    setBulkPriorityValue(priorities.size === 1 ? [...priorities][0] : 0);
    setPriorityDialogOpen(true);
  }, [selectedRunsList, selectionCaps.prioritizable]);

  const handleBulkDownload = useCallback(() => {
    if (selectedIds.size === 0) return;
    batchDownloadMutation.mutate([...selectedIds]);
  }, [batchDownloadMutation, selectedIds]);

  // Filter options derived from current page (counts reflect this page only).
  const workerOptions = useMemo(() => {
    const opts = WORKER_TYPES.map((w) => ({
      value: w as string,
      label: w as string,
      count: allRuns.filter((r) => r.workerType === w).length,
    }));
    const emptyCount = allRuns.filter((r) => !r.workerType).length;
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const statusOptions = useMemo(() => {
    const opts = STATUS_LIST.map((s) => ({
      value: s as string,
      label: s as string,
      count: allRuns.filter((r) => r.run?.status === s).length,
    }));
    const emptyCount = allRuns.filter((r) => !r.run?.status).length;
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const outcomeOptions = useMemo(() => {
    const opts = OUTCOME_LIST.map((o) => ({
      value: o as string,
      label: o as string,
      count: allRuns.filter((r) => r.run?.outcome === o).length,
    }));
    const emptyCount = allRuns.filter((r) => !r.run?.outcome).length;
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const modelOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      if (r.model) counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
      else emptyCount += 1;
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const profileOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      if (r.profileId) counts.set(r.profileId, (counts.get(r.profileId) ?? 0) + 1);
      else emptyCount += 1;
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: profileNameById.get(value) ?? formatId(value), count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns, profileNameById]);

  const osOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      const p = r.run?.os?.platform;
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
      else emptyCount += 1;
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const priorityOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      if (r.priority != null) {
        const k = String(r.priority);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      } else {
        emptyCount += 1;
      }
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([value, count]) => ({ value, label: value, count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const versionOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      if (r.agentVersion) counts.set(r.agentVersion, (counts.get(r.agentVersion) ?? 0) + 1);
      else emptyCount += 1;
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  // Lazy: only fetch report summary when the "report" column is visible.
  const reportColumnVisible = !columnVisibility.isHidden("report");
  const visibleIds = useMemo(
    () => (reportColumnVisible ? allRuns.map((r) => r._id) : []),
    [reportColumnVisible, allRuns],
  );
  const { data: reportSummary } = useQuery({
    queryKey: ["runs-report-summary", visibleIds],
    queryFn: () => api.bulkReportSummary(visibleIds),
    enabled: reportColumnVisible && visibleIds.length > 0,
    staleTime: 10_000,
  });

  const columns: DataTableColumn<Run>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "120px",
      sticky: "left",
      stickyOffset: "40px",
      cell: (r) => <span className="font-mono text-xs">{formatId(r._id)}</span>,
    },
    {
      id: "submission",
      header: "Submission",
      width: "120px",
      hidden: columnVisibility.isHidden("submission"),
      cell: (r) =>
        r.submissionId ? (
          <span className="font-mono text-xs">{formatId(r.submissionId)}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "task",
      header: "Task",
      hidden: columnVisibility.isHidden("task"),
      cell: (r) =>
        r.scenario?.task ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm cursor-default">{truncate(r.scenario.task, 60)}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-pre-wrap text-xs">
              {r.scenario.task}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "criteria",
      header: "Criteria",
      width: "180px",
      hidden: columnVisibility.isHidden("criteria"),
      cell: (r) => {
        const criteria = r.scenario?.criteria ?? [];
        return criteria.length > 0 ? (
          <OverflowBadges
            items={criteria}
            max={1}
            renderItem={(criterionId) => (
              <Tooltip key={criterionId}>
                <TooltipTrigger asChild>
                  <Link
                    to={`/criteria/${criterionId}`}
                    className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {criterionId}
                  </Link>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{criterionId}</TooltipContent>
              </Tooltip>
            )}
            renderMenuItem={(criterionId) => (
              <DropdownMenuItem key={criterionId} asChild>
                <Link
                  to={`/criteria/${criterionId}`}
                  className="font-mono text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  {criterionId}
                </Link>
              </DropdownMenuItem>
            )}
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "worker",
      header: "Worker",
      sortable: true,
      width: "180px",
      hidden: columnVisibility.isHidden("worker"),
      cell: (r) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="max-w-[160px] min-w-0 font-mono text-xs cursor-default">
              <span className="block min-w-0 truncate">{truncate(r.workerType, 18)}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="text-xs">{r.workerType}</TooltipContent>
        </Tooltip>
      ),
    },
    {
      id: "version",
      header: "Version",
      width: "110px",
      hidden: columnVisibility.isHidden("version"),
      cell: (r) =>
        r.agentVersion ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-xs truncate block cursor-default">{r.agentVersion}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{r.agentVersion}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "os",
      header: "OS",
      width: "120px",
      hidden: columnVisibility.isHidden("os"),
      cell: (r) => {
        const os = r.run?.os;
        if (!os) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center cursor-default">
                <OsPlatformIcon platform={os.platform} />
              </span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              {os.platform} {os.release} ({os.arch})
            </TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      id: "mcp",
      header: "MCP",
      width: "180px",
      hidden: columnVisibility.isHidden("mcp"),
      cell: (r) => {
        const servers = r.mcpServers ?? [];
        return servers.length > 0 ? (
          <OverflowBadges
            items={servers}
            max={1}
            renderItem={(slug) => (
              <Tooltip key={slug}>
                <TooltipTrigger asChild>
                  <Link
                    to={`/mcp-servers/${slug}`}
                    className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {slug}
                  </Link>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{slug}</TooltipContent>
              </Tooltip>
            )}
            renderMenuItem={(slug) => (
              <DropdownMenuItem key={slug} asChild>
                <Link
                  to={`/mcp-servers/${slug}`}
                  className="font-mono text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  {slug}
                </Link>
              </DropdownMenuItem>
            )}
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "skills",
      header: "Skills",
      width: "180px",
      hidden: columnVisibility.isHidden("skills"),
      cell: (r) => {
        const refs = (r.skillRevisions ?? r.skills ?? []) as string[];
        return refs.length > 0 ? (
          <OverflowBadges
            items={refs}
            max={1}
            renderItem={(ref) => {
              const skillName = ref.split("@")[0].split("/").pop() ?? ref;
              const skillSlug = ref.split("@")[0];
              return (
                <Tooltip key={ref}>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/skills/${skillSlug}`}
                      className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {truncate(skillName, 20)}
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{ref}</TooltipContent>
                </Tooltip>
              );
            }}
            renderMenuItem={(ref) => {
              const skillName = ref.split("@")[0].split("/").pop() ?? ref;
              const skillSlug = ref.split("@")[0];
              return (
                <DropdownMenuItem key={ref} asChild>
                  <Link
                    to={`/skills/${skillSlug}`}
                    className="font-mono text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {skillName}
                  </Link>
                </DropdownMenuItem>
              );
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "extensions",
      header: "Extensions",
      width: "190px",
      hidden: columnVisibility.isHidden("extensions"),
      cell: (r) => {
        const ids = r.extensions ?? [];
        return ids.length > 0 ? (
          <OverflowBadges
            items={ids}
            max={1}
            renderItem={(id) => {
              const [qualifiedName, version] = id.split("@");
              const shortName = qualifiedName.split(".").pop() ?? id;
              const extensionLabel = `${shortName}${version ? `@${version}` : ""}`;
              return (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/extensions/${qualifiedName}`}
                      className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {truncate(extensionLabel, 20)}
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{id}</TooltipContent>
                </Tooltip>
              );
            }}
            renderMenuItem={(id) => {
              const [qualifiedName, version] = id.split("@");
              const shortName = qualifiedName.split(".").pop() ?? id;
              const extensionLabel = `${shortName}${version ? `@${version}` : ""}`;
              return (
                <DropdownMenuItem key={id} asChild>
                  <Link
                    to={`/extensions/${qualifiedName}`}
                    className="font-mono text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {truncate(extensionLabel, 20)}
                  </Link>
                </DropdownMenuItem>
              );
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "profile",
      header: "Profile",
      width: "220px",
      hidden: columnVisibility.isHidden("profile"),
      cell: (r) => {
        if (!r.profileId) return <span className="text-xs text-muted-foreground">—</span>;

        const profileLabel = profileNameById.get(r.profileId) ?? formatId(r.profileId);

        return (
          <div className="flex min-w-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block min-w-0 truncate text-xs font-medium cursor-default">{profileLabel}</span>
              </TooltipTrigger>
              <TooltipContent className="text-xs">{profileLabel}</TooltipContent>
            </Tooltip>
          </div>
        );
      },
    },
    {
      id: "priority",
      header: "Priority",
      sortable: true,
      width: "80px",
      hidden: columnVisibility.isHidden("priority"),
      cell: (r) =>
        r.priority != null ? (
          <span className="font-mono text-xs">{r.priority}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "model",
      header: "Model",
      width: "180px",
      hidden: columnVisibility.isHidden("model"),
      cell: (r) =>
        r.model ? (
          <Tooltip>
            <TooltipTrigger asChild>
            <span className="font-mono text-xs truncate block max-w-[120px] cursor-default">{r.model}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{r.model}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "effort",
      header: "Effort",
      width: "100px",
      hidden: columnVisibility.isHidden("effort"),
      cell: (r) =>
        r.reasoningEffort ? (
          <span className="font-mono text-xs">{r.reasoningEffort}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "status",
      header: "Status",
      sortable: true,
      width: "120px",
      hidden: columnVisibility.isHidden("status"),
      cell: (r) => (r.run?.status ? <StatusBadge status={r.run.status} /> : <span className="text-xs text-muted-foreground">—</span>),
    },
    {
      id: "outcome",
      header: "Outcome",
      width: "120px",
      hidden: columnVisibility.isHidden("outcome"),
      cell: (r) => (r.run?.outcome ? <OutcomeBadge outcome={r.run.outcome} /> : <span className="text-xs text-muted-foreground">—</span>),
    },
    {
      id: "report",
      header: "Report",
      width: "120px",
      hidden: columnVisibility.isHidden("report"),
      cell: (r) => {
        const s = reportSummary?.[r._id];
        if (!s || s.total === 0) return <span className="text-xs text-muted-foreground">—</span>;
        if (s.failed > 0) return <Badge variant="destructive" className="text-xs">{s.failed} failed</Badge>;
        if (s.generating > 0) return <Badge variant="secondary" className="text-xs">generating</Badge>;
        if (s.pending > 0) return <Badge variant="outline" className="text-xs">{s.pending} pending</Badge>;
        if (s.completed > 0) return <Badge variant="default" className="text-xs">{s.completed} done</Badge>;
        return <span className="text-xs text-muted-foreground">—</span>;
      },
    },
    {
      id: "attempt",
      header: "Attempt",
      width: "80px",
      hidden: columnVisibility.isHidden("attempt"),
      cell: (r) => {
        const n = r.run?.attemptNumber;
        return n != null ? (
          <span className="font-mono text-xs">#{n}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "turns",
      header: "Turns",
      width: "70px",
      hidden: columnVisibility.isHidden("turns"),
      cell: (r) => {
        const n = r.run?.turns?.length ?? 0;
        return n > 0 ? (
          <span className="text-xs">{n}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "llmCalls",
      header: "LLM Calls",
      width: "90px",
      hidden: columnVisibility.isHidden("llmCalls"),
      cell: (r) => {
        const n = r.run?.aiCallCount;
        return n != null && n > 0 ? (
          <span className="text-xs">{n}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "duration",
      header: "Duration",
      sortable: true,
      width: "100px",
      hidden: columnVisibility.isHidden("duration"),
      cell: (r) => {
        const start = r.run?.startedAt;
        const end = r.run?.finishedAt;
        if (!start || !end) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <span className="font-mono text-xs">
            {formatDuration(new Date(end).getTime() - new Date(start).getTime())}
          </span>
        );
      },
    },
    {
      id: "tokens",
      header: "Tokens",
      width: "100px",
      hidden: columnVisibility.isHidden("tokens"),
      cell: (r) => {
        const t = r.run?.tokenUsage?.totalTokens;
        return t != null && t > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-xs cursor-default">{t.toLocaleString()}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              prompt {r.run?.tokenUsage?.promptTokens ?? 0} / completion {r.run?.tokenUsage?.completionTokens ?? 0}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      hidden: columnVisibility.isHidden("created"),
      cell: (r) => <span className="text-xs text-muted-foreground">{formatDate(r.createdAt)}</span>,
    },
    {
      id: "actions",
      header: "",
      width: "152px",
      sticky: "right",
      cell: (r) => (
        <div className="flex items-center justify-end gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="View run"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/runs/${r._id}`);
            }}
          >
            <Eye className="h-3.5 w-3.5" />
            <span className="sr-only">View</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Download archive"
            onClick={(e) => {
              e.stopPropagation();
              window.open(api.archiveUrl(r._id), "_blank");
            }}
          >
            <Download className="h-3.5 w-3.5" />
            <span className="sr-only">Download</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Re-run identical"
            disabled={bulkResubmitMutation.isPending}
            onClick={(e) => {
              e.stopPropagation();
              handleSingleRowResubmit(r._id);
            }}
          >
            <Repeat className="h-3.5 w-3.5" />
            <span className="sr-only">Re-run</span>
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                title="Delete run"
                disabled={bulkDeleteMutation.isPending}
                onClick={(e) => e.stopPropagation()}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="sr-only">Delete</span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent onClick={(e) => e.stopPropagation()}>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete run?</AlertDialogTitle>
                <AlertDialogDescription>
                  This soft-deletes run <span className="font-mono">{formatId(r._id)}</span>. Iterations and logs are retained but the run will be hidden from listings.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={(e) => {
                    e.stopPropagation();
                    bulkDeleteMutation.mutate([r._id]);
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ),
    },
  ];

  // Apply persisted column order. The `id` column is pinned to the left
  // (sticky) and `actions` is pinned to the right; everything in between is
  // sorted by the order from `useColumnOrder`. Unknown ids land at the end of
  // their bucket, which is harmless because the order hook reconciles new ids
  // into the persisted list automatically.
  const orderedColumns: DataTableColumn<Run>[] = (() => {
    const orderIndex = new Map<string, number>();
    columnOrder.order.forEach((id, idx) => orderIndex.set(id, idx));
    const idCol = columns.find((c) => c.id === "id");
    const actionsCol = columns.find((c) => c.id === "actions");
    const middle = columns
      .filter((c) => c.id !== "id" && c.id !== "actions")
      .sort((a, b) => {
        const ai = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bi = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    return [
      ...(idCol ? [idCol] : []),
      ...middle,
      ...(actionsCol ? [actionsCol] : []),
    ];
  })();

  return (
    <TooltipProvider delayDuration={200}>
    <ListLayout
      title="Runs"
      description={
        estimatedTotal != null
          ? `~${estimatedTotal.toLocaleString()} runs total`
          : "Manage and monitor benchmark runs"
      }
      railStorageKey="runs"
      actions={
        <div className="flex items-center gap-2">
          <GroupByToggle
            value={groupBy}
            onChange={(next) => state.setFilter("groupBy", next === "none" ? null : next)}
          />
          <CliCommand command={runListCli} />
        </div>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search runs…"
          refreshing={isRefetching}
          sortablePageKey="runs"
          defaultSectionOrder={["created", "iterations", "worker", "status", "outcome", "model", "profile", "version", "os", "priority", "groupby"]}
          footer={
            <>
              <ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} />
              <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
            </>
          }
        >
          <FilterSection title="Created" storageKey="runs-created" sortableId="created">
            <DateRangeFilter
              from={dateFrom}
              to={dateTo}
              onChange={(f, t) => {
                state.setFilters({ dateFrom: f, dateTo: t });
              }}
            />
          </FilterSection>
          <FilterSection title="Iterations" storageKey="runs-iterations" sortableId="iterations">
            <div className="space-y-2">
              <NumericComparatorRow
                label="Turns"
                ariaLabel="Filter runs by number of turns"
                op={turnsOp}
                value={turnsRaw}
                onChange={({ op, value }) => {
                  state.setFilters({
                    turns: value || null,
                    turnsOp: value ? op : null,
                  });
                }}
              />
              <NumericComparatorRow
                label="Max iter"
                ariaLabel="Filter runs by max iterations"
                op={maxIterOp}
                value={maxIterRaw}
                onChange={({ op, value }) => {
                  state.setFilters({
                    maxIter: value || null,
                    maxIterOp: value ? op : null,
                  });
                }}
              />
            </div>
          </FilterSection>
          <FilterSection title="Worker" storageKey="runs-worker" sortableId="worker">
            <CheckboxFilterGroup
              options={workerOptions}
              selected={workers}
              onToggle={(v) => state.toggleFilterValue("worker", v)}
            />
          </FilterSection>
          <FilterSection title="Status" storageKey="runs-status" sortableId="status">
            <CheckboxFilterGroup
              options={statusOptions}
              selected={statuses}
              onToggle={(v) => state.toggleFilterValue("status", v)}
            />
          </FilterSection>
          <FilterSection title="Outcome" storageKey="runs-outcome" sortableId="outcome">
            <CheckboxFilterGroup
              options={outcomeOptions}
              selected={outcomes}
              onToggle={(v) => state.toggleFilterValue("outcome", v)}
            />
          </FilterSection>
          {modelOptions.length > 0 && (
            <FilterSection title="Model" storageKey="runs-model" defaultOpen={false} sortableId="model">
              <CheckboxFilterGroup
                options={modelOptions}
                selected={models}
                onToggle={(v) => state.toggleFilterValue("model", v)}
              />
            </FilterSection>
          )}
          {profileOptions.length > 0 && (
            <FilterSection title="Profile" storageKey="runs-profile" defaultOpen={false} sortableId="profile">
              <CheckboxFilterGroup
                options={profileOptions}
                selected={profiles}
                onToggle={(v) => state.toggleFilterValue("profile", v)}
              />
            </FilterSection>
          )}
          {versionOptions.length > 0 && (
            <FilterSection title="Version" storageKey="runs-version" defaultOpen={false} sortableId="version">
              <CheckboxFilterGroup
                options={versionOptions}
                selected={versions}
                onToggle={(v) => state.toggleFilterValue("version", v)}
              />
            </FilterSection>
          )}
          {osOptions.length > 0 && (
            <FilterSection title="OS" storageKey="runs-os" defaultOpen={false} sortableId="os">
              <CheckboxFilterGroup
                options={osOptions}
                selected={osList}
                onToggle={(v) => state.toggleFilterValue("os", v)}
              />
            </FilterSection>
          )}
          {priorityOptions.length > 0 && (
            <FilterSection title="Priority" storageKey="runs-priority" defaultOpen={false} sortableId="priority">
              <CheckboxFilterGroup
                options={priorityOptions}
                selected={priorities}
                onToggle={(v) => state.toggleFilterValue("priority", v)}
              />
            </FilterSection>
          )}
        </FilterRail>
      }
      detail={detailOutlet}
      onDetailClose={() =>
        navigate({ pathname: "/runs", search: window.location.search })
      }
      secondaryPanel={
        customizeOpen ? (
          <CustomizeColumnsPanel
            columns={COLUMN_OPTIONS}
            hidden={columnVisibility.hidden}
            onToggle={columnVisibility.toggle}
            onSetHidden={columnVisibility.setHidden}
            onReset={() => {
              columnVisibility.reset();
              columnOrder.reset();
            }}
            onClose={() => setCustomizeOpen(false)}
            order={columnOrder.order}
            onReorder={columnOrder.setOrder}
          />
        ) : null
      }
      onSecondaryClose={() => setCustomizeOpen(false)}
    >
      <div className="flex flex-col gap-3">
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          itemLabel="run"
        >
          <BulkGroupLabel>Scheduling</BulkGroupLabel>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectionCaps.pausable === 0}
            onClick={handleBulkPause}
            title="Pause pending/queued/processing runs"
          >
            <Pause className="h-3.5 w-3.5" /> Pause
            {selectionCaps.pausable > 0 ? ` (${selectionCaps.pausable})` : ""}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectionCaps.resumable === 0}
            onClick={handleBulkResume}
            title="Resume paused runs"
          >
            <Play className="h-3.5 w-3.5" /> Resume
            {selectionCaps.resumable > 0 ? ` (${selectionCaps.resumable})` : ""}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectionCaps.prioritizable === 0}
            onClick={openPriorityDialog}
            title="Set priority on pending/queued/paused runs"
          >
            <ArrowUpDown className="h-3.5 w-3.5" /> Priority
            {selectionCaps.prioritizable > 0 ? ` (${selectionCaps.prioritizable})` : ""}
          </Button>

          <BulkGroupLabel>Runs</BulkGroupLabel>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectedIds.size === 0}
            onClick={openResubmitDialog}
            title="Re-submit selected runs with optional overrides"
          >
            <Repeat className="h-3.5 w-3.5" /> Re-submit
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectionCaps.retryable === 0}
            onClick={handleBulkRetry}
            title={
              isForceRetryModifierActive
                ? "Force retry (ignore attempt limits)"
                : "Retry completed runs — hold Shift to force"
            }
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {isForceRetryModifierActive ? "Force Retry" : "Retry"}
            {selectionCaps.retryable > 0 ? ` (${selectionCaps.retryable})` : ""}
          </Button>

          <BulkGroupLabel>Export</BulkGroupLabel>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectedIds.size === 0}
            onClick={() => setReportDialogOpen(true)}
            title="Generate reports for selected runs"
          >
            <FileText className="h-3.5 w-3.5" /> Reports
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectedIds.size === 0}
            onClick={handleBulkDownload}
            title="Download selected runs as archive"
          >
            <Download className="h-3.5 w-3.5" />
            {batchDownloadMutation.isPending ? "Downloading…" : "Download"}
          </Button>

          <Button
            variant="destructive"
            size="sm"
            className="ml-1 gap-1.5"
            disabled={isBusy || selectedIds.size === 0}
            onClick={() => setDeleteDialogOpen(true)}
            title="Delete selected runs"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <CliCommand command={bulkCli} title="Bulk action from the CLI" />
        </BulkActionBar>

        {groupBy === "none" ? (
          <DataTable
            items={sortedRuns}
            columns={orderedColumns}
            getRowId={(r) => r._id}
            activeId={activeId}
            onRowClick={(r) => navigate({ pathname: `/runs/${r._id}/preview`, search: window.location.search })}
            selection={{
              selectedIds,
              onToggle: (id) => toggleRowSelection(id),
              onToggleAll: (ids) => toggleAllSelection(ids),
            }}
            sort={state.sort}
            sortDir={state.sortDir}
            onSortChange={state.toggleSort}
            loading={isLoading}
            loadingRows={state.pageSize}
            emptyState={
              state.hasActiveFilters
                ? "No runs match the current filters."
                : "No runs yet. Submit one with the New Run button."
            }
          />
        ) : (
          <div className="space-y-4">
            <DataTable
              items={groupedTableItems}
              columns={orderedColumns}
              getRowId={(r) => r._id}
              activeId={activeId}
              onRowClick={(r) => navigate({ pathname: `/runs/${r._id}/preview`, search: window.location.search })}
              selection={{
                selectedIds,
                onToggle: (id) => toggleRowSelection(id),
                onToggleAll: (ids) => toggleAllSelection(ids),
              }}
              grouping={{
                getGroupKey: (run) => {
                  switch (groupBy) {
                    case "profile":
                      return run.profileId ?? "(No Profile)";
                    case "task":
                      return run.scenario?.task ?? "(No Task)";
                    case "submissionId":
                      return run.submissionId ?? "(No Submission)";
                    default:
                      return "";
                  }
                },
                expandedGroupKeys,
                onToggleGroup: toggleGroupExpansion,
                renderGroupCell: (column, runs, expanded) => {
                  const total = runs.length;
                  if (column.id === "id") {
                    return (
                      <div className="flex items-center gap-1.5">
                        {expanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="text-xs font-semibold">
                          {total} run{total !== 1 ? "s" : ""}
                        </span>
                      </div>
                    );
                  }
                  if (column.id === "status") {
                    const doneCount = runs.filter((r) => r.run?.status === "done").length;
                    // A run is considered "failed" at the status level when it
                    // reached the terminal `done` state with a non-succeeded outcome.
                    const failedAtStatus = runs.filter(
                      (r) => r.run?.status === "done" && r.run?.outcome === "failed",
                    ).length;
                    return (
                      <AggregateProgress
                        count={doneCount - failedAtStatus}
                        failedCount={failedAtStatus}
                        total={total}
                        label="done"
                        tone={failedAtStatus > 0 && doneCount === failedAtStatus ? "destructive" : "success"}
                      />
                    );
                  }
                  if (column.id === "outcome") {
                    const passCount = runs.filter((r) => r.run?.outcome === "succeeded").length;
                    const failedCount = runs.filter((r) => r.run?.outcome === "failed").length;
                    return (
                      <AggregateProgress
                        count={passCount}
                        failedCount={failedCount}
                        total={total}
                        label="pass"
                        tone={failedCount > 0 && passCount === 0 ? "destructive" : "success"}
                        pendingLabel="no outcome"
                      />
                    );
                  }
                  if (column.id === "os") {
                    const platforms = Array.from(
                      new Set(
                        runs
                          .map((r) => r.run?.os?.platform)
                          .filter((p): p is string => !!p),
                      ),
                    ).sort();
                    if (platforms.length === 0) {
                      return <span className="text-xs text-muted-foreground">—</span>;
                    }
                    return (
                      <div className="flex items-center gap-1">
                        {platforms.map((platform) => (
                          <OsPlatformIcon key={platform} platform={platform} />
                        ))}
                      </div>
                    );
                  }
                  if (column.id === "profile" && groupBy === "profile") {
                    const groupKey = runs[0]?.profileId ?? "(No Profile)";
                    const profileLabel =
                      groupKey !== "(No Profile)"
                        ? (profileNameById.get(groupKey) ?? formatId(groupKey))
                        : "—";
                    return (
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block min-w-0 truncate text-xs font-medium cursor-default">
                              {profileLabel}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">{profileLabel}</TooltipContent>
                        </Tooltip>
                      </div>
                    );
                  }

                  // Distinct-value aggregate: for identifier/categorical columns,
                  // render the single shared value via the row cell when uniform;
                  // otherwise show "N distinct" with a tooltip listing the values.
                  const distinct = (
                    label: string,
                    getKey: (r: Run) => string | null | undefined,
                    renderSingle?: (r: Run) => ReactNode,
                  ): ReactNode => {
                    const values = Array.from(
                      new Set(
                        runs
                          .map(getKey)
                          .filter((v): v is string => v != null && v !== ""),
                      ),
                    );
                    if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                    if (values.length === 1) {
                      const first = runs.find((r) => getKey(r) === values[0]) ?? runs[0];
                      return renderSingle ? renderSingle(first) : column.cell(first);
                    }
                    return (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs font-medium text-muted-foreground cursor-default">
                            {values.length} {label}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs max-w-xs">
                          <div className="flex flex-col gap-0.5 font-mono">
                            {values.slice(0, 10).map((v) => (
                              <span key={v}>{v}</span>
                            ))}
                            {values.length > 10 && <span>… +{values.length - 10} more</span>}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    );
                  };

                  // Numeric stats over a population of run values. Sums + central
                  // tendency + spread so reviewers can spot skew without leaving the row.
                  const computeNumericStats = (values: number[]) => {
                    const sorted = [...values].sort((a, b) => a - b);
                    const n = sorted.length;
                    const sum = sorted.reduce((a, b) => a + b, 0);
                    const min = sorted[0];
                    const max = sorted[n - 1];
                    const mean = sum / n;
                    const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
                    return { n, sum, min, max, mean, median };
                  };

                  // Compact stats popover content. Always shows the same five
                  // aggregates so the layout stays predictable across columns.
                  const renderStatsTooltip = (
                    values: number[],
                    formatValue: (n: number) => string,
                  ): ReactNode => {
                    const s = computeNumericStats(values);
                    const rows: Array<[string, string]> = [
                      ["Sum", formatValue(s.sum)],
                      ["Min", formatValue(s.min)],
                      ["Mean", formatValue(s.mean)],
                      ["Median", formatValue(s.median)],
                      ["Max", formatValue(s.max)],
                    ];
                    return (
                      <div className="text-xs">
                        <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {s.n} run{s.n !== 1 ? "s" : ""}
                        </div>
                        <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono">
                          {rows.map(([label, val]) => (
                            <Fragment key={label}>
                              <span className="text-muted-foreground">{label}</span>
                              <span className="text-right tabular-nums">{val}</span>
                            </Fragment>
                          ))}
                        </div>
                      </div>
                    );
                  };

                  // Numeric aggregate: primary value in the cell (default: sum),
                  // full min/mean/median/max breakdown in the tooltip.
                  const numericAggregate = (
                    getN: (r: Run) => number | null | undefined,
                    options?: {
                      formatValue?: (n: number) => string;
                      primary?: "sum" | "max" | "mean";
                    },
                  ): ReactNode => {
                    const values = runs.map(getN).filter((n): n is number => n != null && !Number.isNaN(n));
                    if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                    const formatValue = options?.formatValue ?? ((n: number) => Math.round(n).toLocaleString());
                    const stats = computeNumericStats(values);
                    const primaryKey = options?.primary ?? "sum";
                    const primaryValue =
                      primaryKey === "max" ? stats.max : primaryKey === "mean" ? stats.mean : stats.sum;
                    return (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="font-mono text-xs cursor-default tabular-nums underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
                            {formatValue(primaryValue)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          {renderStatsTooltip(values, formatValue)}
                        </TooltipContent>
                      </Tooltip>
                    );
                  };

                  switch (column.id) {
                    case "submission":
                      return distinct("submissions", (r) => r.submissionId);
                    case "task":
                      return distinct("tasks", (r) => r.scenario?.task);
                    case "worker":
                      return distinct("workers", (r) => r.workerType);
                    case "version":
                      return distinct("versions", (r) => r.agentVersion);
                    case "model":
                      return distinct("models", (r) => r.model);

                    case "criteria": {
                      const union = Array.from(
                        new Set(runs.flatMap((r) => r.scenario?.criteria ?? [])),
                      );
                      if (union.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const synthetic = { ...runs[0], scenario: { ...runs[0].scenario, criteria: union } } as Run;
                      return column.cell(synthetic);
                    }
                    case "mcp": {
                      const union = Array.from(
                        new Set(runs.flatMap((r) => r.mcpServers ?? [])),
                      );
                      if (union.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const synthetic = { ...runs[0], mcpServers: union } as Run;
                      return column.cell(synthetic);
                    }
                    case "skills": {
                      const union = Array.from(
                        new Set(runs.flatMap((r) => (r.skillRevisions ?? r.skills ?? []) as string[])),
                      );
                      if (union.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const synthetic = { ...runs[0], skillRevisions: union, skills: union } as Run;
                      return column.cell(synthetic);
                    }
                    case "extensions": {
                      const union = Array.from(
                        new Set(runs.flatMap((r) => r.extensions ?? [])),
                      );
                      if (union.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const synthetic = { ...runs[0], extensions: union } as Run;
                      return column.cell(synthetic);
                    }

                    case "priority": {
                      const values = runs
                        .map((r) => r.priority)
                        .filter((p): p is number => p != null);
                      if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const stats = computeNumericStats(values);
                      const label =
                        stats.min === stats.max ? `${stats.min}` : `${stats.min}–${stats.max}`;
                      return (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="font-mono text-xs cursor-default tabular-nums underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
                              {label}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">
                            {renderStatsTooltip(values, (n) => Math.round(n).toLocaleString())}
                          </TooltipContent>
                        </Tooltip>
                      );
                    }

                    case "attempt": {
                      return numericAggregate((r) => r.run?.attemptNumber, {
                        primary: "max",
                        formatValue: (n) => `#${Math.round(n).toLocaleString()}`,
                      });
                    }

                    case "turns":
                      return numericAggregate((r) => r.run?.turns?.length);
                    case "llmCalls":
                      return numericAggregate((r) => r.run?.aiCallCount);
                    case "tokens":
                      return numericAggregate((r) => r.run?.tokenUsage?.totalTokens);

                    case "duration": {
                      return numericAggregate(
                        (r) => {
                          const s = r.run?.startedAt;
                          const e = r.run?.finishedAt;
                          if (!s || !e) return null;
                          const ms = new Date(e).getTime() - new Date(s).getTime();
                          return ms >= 0 ? ms : null;
                        },
                        { formatValue: (n) => formatDuration(Math.round(n)) },
                      );
                    }

                    case "created": {
                      const times = runs.map((r) => new Date(r.createdAt).getTime()).filter((n) => !Number.isNaN(n));
                      if (times.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const earliest = new Date(Math.min(...times)).toISOString();
                      const latest = new Date(Math.max(...times)).toISOString();
                      return (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-xs text-muted-foreground cursor-default">{formatDate(earliest)}</span>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">
                            <div>earliest: {formatDate(earliest)}</div>
                            <div>latest: {formatDate(latest)}</div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    }

                    case "report": {
                      if (!reportSummary) return <span className="text-xs text-muted-foreground">—</span>;
                      const totals = runs.reduce(
                        (acc, r) => {
                          const s = reportSummary[r._id];
                          if (!s) return acc;
                          acc.failed += s.failed;
                          acc.generating += s.generating;
                          acc.pending += s.pending;
                          acc.completed += s.completed;
                          acc.total += s.total;
                          return acc;
                        },
                        { failed: 0, generating: 0, pending: 0, completed: 0, total: 0 },
                      );
                      if (totals.total === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      if (totals.failed > 0)
                        return <Badge variant="destructive" className="text-xs">{totals.failed} failed</Badge>;
                      if (totals.generating > 0)
                        return <Badge variant="secondary" className="text-xs">generating</Badge>;
                      if (totals.pending > 0)
                        return <Badge variant="outline" className="text-xs">{totals.pending} pending</Badge>;
                      if (totals.completed > 0)
                        return <Badge variant="default" className="text-xs">{totals.completed} done</Badge>;
                      return <span className="text-xs text-muted-foreground">—</span>;
                    }
                  }

                  // Default: render the first run's cell (works when the column
                  // value is uniform across the group, e.g. submission/task when
                  // grouped by submissionId, or profile when grouped by profile).
                  return runs[0] ? column.cell(runs[0]) : null;
                },
                renderGroupHeader: (groupKey, runs, expanded) => {
                  const groupLabel = groupBy === "submissionId" ? "Submission ID" : groupBy === "profile" ? "Profile" : "Task";
                  const groupDisplayKey =
                    groupBy === "profile" && groupKey !== "(No Profile)"
                      ? (profileNameById.get(groupKey) ?? formatId(groupKey))
                      : groupKey;
                  return (
                    <button
                      type="button"
                      onClick={() => toggleGroupExpansion(groupKey)}
                      className="w-full bg-muted/30 px-4 py-3 text-sm flex items-center justify-between gap-3 hover:bg-muted/40 transition-colors"
                      aria-expanded={expanded}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {expanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="min-w-0 truncate font-semibold">
                          <span className="text-muted-foreground">{groupLabel}:</span> {groupDisplayKey}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-xs text-muted-foreground font-normal">
                          {runs.length} run{runs.length !== 1 ? "s" : ""}
                        </span>
                        <span className="text-xs text-muted-foreground font-normal">
                          {expanded ? "Click to collapse" : "Click to expand"}
                        </span>
                      </div>
                    </button>
                  );
                },
              }}
              sort={state.sort}
              sortDir={state.sortDir}
              onSortChange={state.toggleSort}
              loading={isLoading}
              loadingRows={state.pageSize}
              emptyState=""
            />
            {groupedRuns.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                {state.hasActiveFilters
                  ? "No runs match the current filters."
                  : "No runs yet. Submit one with the New Run button."}
              </div>
            )}
          </div>
        )}
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={estimatedTotal}
          onPageChange={handlePageChange}
          onPageSizeChange={state.setPageSize}
          hasNext={!!cursors.next}
          hasPrev={state.page > 1}
          itemLabel="runs"
        />
      </div>

      <AlertDialog open={resubmitDialogOpen} onOpenChange={setResubmitDialogOpen}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Re-submit {selectedIds.size} run{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              New runs copy the original scenario and settings. Use overrides below to change specific fields.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-2 max-h-[65vh] overflow-y-auto pr-1">
            <div className="flex items-center gap-4">
              <Label htmlFor="resubmit-count" className="text-sm font-medium w-32 shrink-0">Copies per run</Label>
              <Input
                id="resubmit-count"
                type="number"
                min={1}
                max={10}
                value={resubmitCount}
                onChange={(e) => setResubmitCount(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                className="w-24"
              />
              <span className="text-xs text-muted-foreground">
                = {selectedIds.size * resubmitCount} new run{selectedIds.size * resubmitCount !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="border-t pt-4">
              <p className="text-sm font-medium mb-3">Overrides <span className="text-muted-foreground font-normal">(leave unchanged to copy from source)</span></p>

              {/* Profile */}
              <div className="flex items-center gap-4 mb-3">
                <Label className="text-sm w-32 shrink-0">Profile</Label>
                <Select
                  value={resubmitOverrides.profileId === null ? "__none__" : resubmitOverrides.profileId ?? "__keep__"}
                  onValueChange={(v) => setResubmitOverrides((prev) => {
                    const next = { ...prev };
                    if (v === "__keep__") {
                      delete next.profileId;
                    } else if (v === "__none__") {
                      next.profileId = null;
                    } else {
                      next.profileId = v;
                    }
                    // Profile values take precedence — clear field overrides it controls.
                    delete next.workerType;
                    delete next.model;
                    delete next.mcpServers;
                    delete next.skillRevisions;
                    delete next.extensions;
                    return next;
                  })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">
                      {selectedRunsSummary.profileId
                        ? <>
                            {profileNameById.get(selectedRunsSummary.profileId) ?? formatId(selectedRunsSummary.profileId)}
                            {selectedRunsSummary.profileVersion && <span className="text-muted-foreground"> v{selectedRunsSummary.profileVersion}</span>}
                          </>
                        : selectedRunsSummary.isMultiProfile ? "Mixed (keep each)" : "None"}
                    </SelectItem>
                    <SelectItem value="__none__">None (detach profile)</SelectItem>
                    {(profilesData ?? []).map((p) => (
                      <SelectItem key={p._id} value={p._id}>
                        {p.name} <span className="text-muted-foreground">v{p.latestVersion}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {activeProfile && (
                <div className="flex items-center gap-2 mb-3 px-1 py-1.5 text-xs text-muted-foreground bg-muted/50 rounded">
                  <Lock className="h-3 w-3 shrink-0" />
                  Worker, model, MCP servers, skills, and extensions are controlled by the profile
                </div>
              )}

              {/* Worker */}
              <div className="flex items-center gap-4 mb-3" title={activeProfile ? "Controlled by profile" : undefined}>
                <Label className="text-sm w-32 shrink-0 flex items-center gap-1.5">
                  {activeProfile && <Lock className="h-3 w-3 text-muted-foreground" />}
                  Worker
                </Label>
                {activeProfile ? (
                  <span className="text-sm text-muted-foreground">{activeProfile.version.workerType}</span>
                ) : (
                <Select
                  value={resubmitOverrides.workerType ?? "__keep__"}
                  onValueChange={(v) => setResubmitOverrides((prev) => {
                    const next = { ...prev };
                    if (v === "__keep__") { delete next.workerType; } else { next.workerType = v; }
                    delete next.model;
                    const effectiveWorkerType = v === "__keep__" ? selectedRunsSummary.worker : v;
                    if (effectiveWorkerType && !effectiveWorkerType.includes("vscode")) {
                      next.extensions = null;
                    } else {
                      delete next.extensions;
                    }
                    return next;
                  })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">
                      {selectedRunsSummary.worker
                        ? selectedRunsSummary.worker
                        : selectedRunsSummary.isMultiWorker ? "Mixed (keep each)" : "—"}
                    </SelectItem>
                    {availableAgents
                      .filter((a) => a._id !== selectedRunsSummary.worker)
                      .map((a) => (
                        <SelectItem key={a._id} value={a._id}>{a.name}</SelectItem>
                      ))}
                    {availableAgents.length === 0 && WORKER_TYPES.filter((w) => w !== selectedRunsSummary.worker).map((w) => (
                      <SelectItem key={w} value={w}>{w}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                )}
              </div>

              {/* Model */}
              <div className="flex items-center gap-4 mb-3" title={activeProfile ? "Controlled by profile" : undefined}>
                <Label className="text-sm w-32 shrink-0 flex items-center gap-1.5">
                  {activeProfile && <Lock className="h-3 w-3 text-muted-foreground" />}
                  Model
                </Label>
                {activeProfile ? (
                  <span className="text-sm text-muted-foreground">{activeProfile.version.model}</span>
                ) : (
                <Select
                  value={resubmitOverrides.model === null ? "__clear__" : resubmitOverrides.model ?? "__keep__"}
                  onValueChange={(v) => setResubmitOverrides((prev) => {
                    const next = { ...prev };
                    if (v === "__keep__") { delete next.model; }
                    else if (v === "__clear__") { next.model = null; }
                    else { next.model = v; }
                    return next;
                  })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">
                      {selectedRunsSummary.model
                        ? selectedRunsSummary.model
                        : selectedRunsSummary.isMultiModel ? "Mixed (keep each)" : "Default"}
                    </SelectItem>
                    <SelectItem value="__clear__">Clear (use default)</SelectItem>
                    <ModelSelectItems
                      models={availableModels}
                      capabilitiesMap={resubmitCapabilitiesMap}
                      defaultModel={effectiveAgent?.defaultModel}
                      excludeModel={selectedRunsSummary.model ?? undefined}
                    />
                    {!effectiveWorker && (
                      <SelectItem value="__hint__" disabled>
                        Select a worker to see models
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                )}
              </div>

              {/* Reasoning effort */}
              {resubmitSupportedEfforts.length > 0 && (
              <div className="flex items-center gap-4 mb-3">
                <Label className="text-sm w-32 shrink-0">Reasoning effort</Label>
                <Select
                  value={resubmitOverrides.reasoningEffort === null ? "__clear__" : resubmitOverrides.reasoningEffort ?? "__keep__"}
                  onValueChange={(v) => setResubmitOverrides((prev) => {
                    const next = { ...prev };
                    if (v === "__keep__") { delete next.reasoningEffort; }
                    else if (v === "__clear__") { next.reasoningEffort = null; }
                    else { next.reasoningEffort = v; }
                    return next;
                  })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">Keep original</SelectItem>
                    <SelectItem value="__clear__">Clear (use default)</SelectItem>
                    {resubmitSupportedEfforts.map((level) => (
                      <SelectItem key={level} value={level}>{level}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              )}

              {/* Max iterations */}
              <div className="flex items-center gap-4 mb-3">
                <Label className="text-sm w-32 shrink-0">Max iterations</Label>
                <Select
                  value={resubmitOverrides.maxIterations === null ? "__clear__" : resubmitOverrides.maxIterations?.toString() ?? "__keep__"}
                  onValueChange={(v) => setResubmitOverrides((prev) => {
                    const next = { ...prev };
                    if (v === "__keep__") { delete next.maxIterations; }
                    else if (v === "__clear__") { next.maxIterations = null; }
                    else { next.maxIterations = parseInt(v); }
                    return next;
                  })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">
                      {selectedRunsSummary.maxIterations
                        ? String(selectedRunsSummary.maxIterations)
                        : selectedRunsSummary.isMultiIterations ? "Mixed (keep each)" : "Default"}
                    </SelectItem>
                    <SelectItem value="__clear__">Clear (use default)</SelectItem>
                    {[1, 2, 3, 5, 10, 15, 20].filter((n) => n !== selectedRunsSummary.maxIterations).map((n) => (
                      <SelectItem key={n} value={n.toString()}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* MCP servers */}
              {activeProfile ? (
              <div className="flex items-start gap-4 mb-3" title="Controlled by profile">
                <Label className="text-sm w-32 shrink-0 pt-0.5 flex items-center gap-1.5">
                  <Lock className="h-3 w-3 text-muted-foreground" />MCP Servers
                </Label>
                <span className="text-sm text-muted-foreground">
                  {activeProfile.version.mcpServers?.join(", ") || "None"}
                </span>
              </div>
              ) : (
              <div className="flex items-start gap-4 mb-3">
                <Label className="text-sm w-32 shrink-0 pt-2">MCP Servers</Label>
                <div className="flex-1 space-y-1.5">
                  <Select
                    value={resubmitOverrides.mcpServers === null ? "__clear__" : resubmitOverrides.mcpServers !== undefined ? "__custom__" : "__keep__"}
                    onValueChange={(v) => setResubmitOverrides((prev) => {
                      const next = { ...prev };
                      if (v === "__keep__") { delete next.mcpServers; }
                      else if (v === "__clear__") { next.mcpServers = null; }
                      else { next.mcpServers = []; }
                      return next;
                    })}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue>
                        {resubmitOverrides.mcpServers === null
                          ? "Clear (no MCP servers)"
                          : resubmitOverrides.mcpServers !== undefined
                            ? "Choose servers…"
                            : selectedRunsSummary.mcpServers && selectedRunsSummary.mcpServers.length > 0
                              ? selectedRunsSummary.mcpServers.join(", ")
                              : selectedRunsSummary.isMultiMcp ? "Mixed (keep each)" : "None"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__keep__">
                        {selectedRunsSummary.mcpServers && selectedRunsSummary.mcpServers.length > 0
                          ? selectedRunsSummary.mcpServers.join(", ")
                          : selectedRunsSummary.isMultiMcp ? "Mixed (keep each)" : "None"}
                      </SelectItem>
                      <SelectItem value="__clear__">Clear (no MCP servers)</SelectItem>
                      <SelectItem value="__custom__">Choose servers…</SelectItem>
                    </SelectContent>
                  </Select>
                  {resubmitOverrides.mcpServers !== undefined && resubmitOverrides.mcpServers !== null && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {mcpServersData.map((s) => {
                        const selected = resubmitOverrides.mcpServers?.includes(s._id) ?? false;
                        return (
                          <Button
                            key={s._id}
                            type="button"
                            variant={selected ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setResubmitOverrides((prev) => {
                              const current = prev.mcpServers ?? [];
                              const next = selected ? current.filter((id) => id !== s._id) : [...current, s._id];
                              return { ...prev, mcpServers: next };
                            })}
                          >
                            {s.name}
                          </Button>
                        );
                      })}
                      {mcpServersData.length === 0 && (
                        <span className="text-xs text-muted-foreground italic">No MCP servers configured</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* Skills */}
              {activeProfile ? (
              <div className="flex items-start gap-4 mb-3" title="Controlled by profile">
                <Label className="text-sm w-32 shrink-0 pt-0.5 flex items-center gap-1.5">
                  <Lock className="h-3 w-3 text-muted-foreground" />Skills
                </Label>
                <span className="text-sm text-muted-foreground">
                  {activeProfile.version.skillRevisions?.map((r) => r.split("@")[0].split("/").pop()).join(", ") || "None"}
                </span>
              </div>
              ) : (
              <div className="flex items-start gap-4 mb-3">
                <Label className="text-sm w-32 shrink-0 pt-2">Skills</Label>
                <div className="flex-1 space-y-1.5">
                  <Select
                    value={resubmitOverrides.skillRevisions === null ? "__clear__" : resubmitOverrides.skillRevisions !== undefined ? "__custom__" : "__keep__"}
                    onValueChange={(v) => setResubmitOverrides((prev) => {
                      const next = { ...prev };
                      if (v === "__keep__") { delete next.skillRevisions; }
                      else if (v === "__clear__") { next.skillRevisions = null; }
                      else { next.skillRevisions = []; }
                      return next;
                    })}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue>
                        {resubmitOverrides.skillRevisions === null
                          ? "Clear (no skills)"
                          : resubmitOverrides.skillRevisions !== undefined
                            ? "Choose skills…"
                            : selectedRunsSummary.skillRevisions && selectedRunsSummary.skillRevisions.length > 0
                              ? selectedRunsSummary.skillRevisions.map((r) => r.split("@")[0].split("/").pop()).join(", ")
                              : selectedRunsSummary.isMultiSkills ? "Mixed (keep each)" : "None"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__keep__">
                        {selectedRunsSummary.skillRevisions && selectedRunsSummary.skillRevisions.length > 0
                          ? selectedRunsSummary.skillRevisions.map((r) => r.split("@")[0].split("/").pop()).join(", ")
                          : selectedRunsSummary.isMultiSkills ? "Mixed (keep each)" : "None"}
                      </SelectItem>
                      <SelectItem value="__clear__">Clear (no skills)</SelectItem>
                      <SelectItem value="__custom__">Choose skills…</SelectItem>
                    </SelectContent>
                  </Select>
                  {resubmitOverrides.skillRevisions !== undefined && resubmitOverrides.skillRevisions !== null && (() => {
                    const allRefs = [...new Set(
                      selectedRunsList.flatMap((r) => r.skillRevisions ?? [])
                    )];
                    return (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {allRefs.map((ref) => {
                          const selected = resubmitOverrides.skillRevisions?.includes(ref) ?? false;
                          const skillName = ref.split("@")[0].split("/").pop() ?? ref;
                          return (
                            <Button
                              key={ref}
                              type="button"
                              variant={selected ? "default" : "outline"}
                              size="sm"
                              className="h-7 text-xs"
                              title={ref}
                              onClick={() => setResubmitOverrides((prev) => {
                                const current = prev.skillRevisions ?? [];
                                const next = selected ? current.filter((r) => r !== ref) : [...current, ref];
                                return { ...prev, skillRevisions: next };
                              })}
                            >
                              {skillName}
                            </Button>
                          );
                        })}
                        {allRefs.length === 0 && (
                          <span className="text-xs text-muted-foreground italic">No skills in selected runs</span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              )}

              {/* Extensions (VS Code workers only) */}
              {activeProfile ? (
                effectiveWorker?.includes("vscode") && (
                <div className="flex items-start gap-4 mb-3" title="Controlled by profile">
                  <Label className="text-sm w-32 shrink-0 pt-0.5 flex items-center gap-1.5">
                    <Lock className="h-3 w-3 text-muted-foreground" />Extensions
                  </Label>
                  <span className="text-sm text-muted-foreground">
                    {activeProfile.version.extensions?.join(", ") || "None"}
                  </span>
                </div>
                )
              ) : (
              effectiveWorker?.includes("vscode") && (
              <div className="flex items-start gap-4">
                <Label className="text-sm w-32 shrink-0 pt-2">Extensions</Label>
                <div className="flex-1 space-y-1.5">
                  <Select
                    value={resubmitOverrides.extensions === null ? "__clear__" : resubmitOverrides.extensions !== undefined ? "__custom__" : "__keep__"}
                    onValueChange={(v) => setResubmitOverrides((prev) => {
                      const next = { ...prev };
                      if (v === "__keep__") { delete next.extensions; }
                      else if (v === "__clear__") { next.extensions = null; }
                      else { next.extensions = []; }
                      return next;
                    })}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue>
                        {resubmitOverrides.extensions === null
                          ? "Clear (no extensions)"
                          : resubmitOverrides.extensions !== undefined
                            ? "Choose extensions…"
                            : selectedRunsSummary.extensions && selectedRunsSummary.extensions.length > 0
                              ? selectedRunsSummary.extensions.join(", ")
                              : selectedRunsSummary.isMultiExtensions ? "Mixed (keep each)" : "None"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__keep__">
                        {selectedRunsSummary.extensions && selectedRunsSummary.extensions.length > 0
                          ? selectedRunsSummary.extensions.join(", ")
                          : selectedRunsSummary.isMultiExtensions ? "Mixed (keep each)" : "None"}
                      </SelectItem>
                      <SelectItem value="__clear__">Clear (no extensions)</SelectItem>
                      <SelectItem value="__custom__">Choose extensions…</SelectItem>
                    </SelectContent>
                  </Select>
                  {resubmitOverrides.extensions !== undefined && resubmitOverrides.extensions !== null && (() => {
                    const allExts = [...new Set(
                      selectedRunsList.flatMap((r) => r.extensions ?? [])
                    )];
                    return (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {allExts.map((ext) => {
                          const selected = resubmitOverrides.extensions?.includes(ext) ?? false;
                          return (
                            <Button
                              key={ext}
                              type="button"
                              variant={selected ? "default" : "outline"}
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => setResubmitOverrides((prev) => {
                                const current = prev.extensions ?? [];
                                const next = selected ? current.filter((e) => e !== ext) : [...current, ext];
                                return { ...prev, extensions: next };
                              })}
                            >
                              {ext}
                            </Button>
                          );
                        })}
                        {allExts.length === 0 && (
                          <span className="text-xs text-muted-foreground italic">No extensions in selected runs</span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              ))}
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setResubmitCount(1); setResubmitOverrides({}); }}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                bulkResubmitMutation.mutate({ ids: [...selectedIds], count: resubmitCount, overrides: resubmitOverrides });
              }}
              disabled={bulkResubmitMutation.isPending}
            >
              {bulkResubmitMutation.isPending ? "Re-submitting…" : "Re-submit"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} run{selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected runs along with their logs,
              turns, and report associations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setDeleteDialogOpen(false);
                bulkDeleteMutation.mutate([...selectedIds]);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={priorityDialogOpen} onOpenChange={setPriorityDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Set priority on {selectionCaps.prioritizable} run
              {selectionCaps.prioritizable !== 1 ? "s" : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Only pending, queued, and paused runs accept priority updates. Higher
              numbers run sooner; lower numbers run later. Range: −100 to 100.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="bulk-priority">Priority</Label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setBulkPriorityValue((v) => Math.max(-100, v - 5))}
              >
                −5
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setBulkPriorityValue((v) => Math.max(-100, v - 1))}
              >
                −1
              </Button>
              <Input
                id="bulk-priority"
                type="number"
                min={-100}
                max={100}
                value={bulkPriorityValue}
                onChange={(e) =>
                  setBulkPriorityValue(
                    Math.max(-100, Math.min(100, parseInt(e.target.value, 10) || 0))
                  )
                }
                className="h-8 text-center"
              />
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setBulkPriorityValue((v) => Math.min(100, v + 1))}
              >
                +1
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setBulkPriorityValue((v) => Math.min(100, v + 5))}
              >
                +5
              </Button>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                bulkSetPriorityMutation.mutate({
                  ids: [...selectedIds],
                  priority: bulkPriorityValue,
                });
              }}
              disabled={bulkSetPriorityMutation.isPending}
            >
              {bulkSetPriorityMutation.isPending ? "Updating…" : "Set priority"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={reportDialogOpen} onOpenChange={setReportDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Generate reports for {selectedIds.size} run
              {selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This queues a fresh report for every selected run. Runs that already
              have a report will get a new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                bulkReportMutation.mutate([...selectedIds]);
              }}
              disabled={bulkReportMutation.isPending}
            >
              {bulkReportMutation.isPending ? "Queuing…" : "Generate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ListLayout>
    </TooltipProvider>
  );
}

function BulkGroupLabel({ children }: { children: ReactNode }) {
  return (
    <span className="ml-2 hidden text-[10px] font-semibold uppercase tracking-wide text-muted-foreground first:ml-0 xl:inline">
      {children}
    </span>
  );
}

/** Parse version number from a profileVersionId of the form "<profileId>@<version>". */
function parseProfileVersion(pvId?: string): number | null {
  if (!pvId) return null;
  const v = pvId.split("@")[1];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function sortKey(r: Run, col: string): string | number {
  switch (col) {
    case "id":
      return r._id;
    case "worker":
      return r.workerType;
    case "priority":
      return r.priority ?? 0;
    case "status":
      return r.run?.status ?? "";
    case "duration": {
      const start = r.run?.startedAt;
      const end = r.run?.finishedAt;
      if (!start || !end) return 0;
      return new Date(end).getTime() - new Date(start).getTime();
    }
    case "created":
      return new Date(r.createdAt).getTime();
    default:
      return "";
  }
}

// Suppress unused warnings for re-exported types kept for callers.
export type { RunStatus, RunOutcome };
