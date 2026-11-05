// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clock, RotateCcw, Unlink } from "lucide-react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { toast } from "sonner";
import { ExperimentReportCard } from "@/components/ExperimentReportCard";
import { ExperimentStatusCard } from "@/components/ExperimentStatusCard";
import { ShortId } from "@/components/ShortId";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CustomizeColumnsLink,
  CustomizeColumnsPanel,
  DataTable,
  EmbeddedTableBlock,
  Pagination,
  useColumnOrder,
  useHiddenColumns,
  type CustomizeColumnsOption,
  type DataTableColumn,
} from "@/components/list-layout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ApiError, api } from "@/lib/api";
import {
  groupExperimentReports,
  resolveExperimentReportSelection,
} from "@/lib/experiment-reports";
import type {
  ExperimentExecutionView,
  ExperimentRequestSummaryView,
  ExperimentView,
} from "@/lib/experiments";
import { formatDate, truncate } from "@/lib/utils";
import type { ReportTemplate } from "@/types";

const RUN_COLUMN_OPTIONS: CustomizeColumnsOption[] = [
  { id: "requestId", label: "ID", required: true },
  { id: "status", label: "Status" },
  { id: "outcome", label: "Outcome" },
  { id: "task", label: "Task" },
  { id: "worker", label: "Worker" },
  { id: "model", label: "Model" },
  { id: "profile", label: "Profile" },
  { id: "runId", label: "Run ID" },
];
const RUN_COLUMN_IDS = RUN_COLUMN_OPTIONS.map((column) => column.id);
const DEFAULT_PAGE_SIZE = 10;

type RunSortColumn = (typeof RUN_COLUMN_IDS)[number];
type SortDirection = "asc" | "desc";
type ExperimentDetailTab = "runs" | "reports" | "processing";

const EXPERIMENT_DETAIL_TABS: ExperimentDetailTab[] = [
  "runs",
  "reports",
  "processing",
];

function handlerStatus(value: unknown): string | undefined {
  if (
    value &&
    typeof value === "object" &&
    "status" in value &&
    typeof value.status === "string"
  ) {
    return value.status;
  }
  return undefined;
}

function handlerError(value: unknown): string | undefined {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return undefined;
}

function requestSortValue(
  request: ExperimentRequestSummaryView,
  column: RunSortColumn,
): string {
  switch (column) {
    case "requestId":
      return request.requestId;
    case "runId":
      return request.runId;
    case "task":
      return request.task ?? "";
    case "status":
      return request.status ?? "";
    case "outcome":
      return request.outcome ?? "";
    case "worker":
      return request.workerType ?? "";
    case "model":
      return request.model ?? "";
    case "profile":
      return request.profileId ?? "";
    default:
      return "";
  }
}

function ExecutionSummary({
  execution,
  current,
}: {
  execution: ExperimentExecutionView;
  current: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          Execution attempt {execution.attemptNumber}
        </CardTitle>
        <Badge variant={current ? "default" : "secondary"}>
          {current ? "Current" : "Historical"}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-muted-foreground">Execution ID</div>
          <ShortId
            id={execution.experimentExecutionId}
            label="experiment execution ID"
          />
        </div>
        <div>
          <div className="text-muted-foreground">Runs</div>
          <div className="font-medium">{execution.requestCount}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Readiness</div>
          <div className="font-medium">{execution.readiness ?? "unknown"}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Created</div>
          <div className="font-medium">{formatDate(execution.createdAt)}</div>
        </div>
        {execution.version !== undefined && (
          <div>
            <div className="text-muted-foreground">Version</div>
            <div className="font-medium">{execution.version}</div>
          </div>
        )}
        {execution.startedAt && (
          <div>
            <div className="text-muted-foreground">Started</div>
            <div className="font-medium">{formatDate(execution.startedAt)}</div>
          </div>
        )}
        {execution.finishedAt && (
          <div>
            <div className="text-muted-foreground">Finished</div>
            <div className="font-medium">{formatDate(execution.finishedAt)}</div>
          </div>
        )}
        {execution.supersededReason && (
          <div>
            <div className="text-muted-foreground">Superseded by</div>
            <div className="font-medium">{execution.supersededReason}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function selectedExperimentView(
  experiment: ExperimentView,
  execution: ExperimentExecutionView,
): ExperimentView {
  const current =
    execution.experimentExecutionId ===
    experiment.execution.experimentExecutionId;
  return {
    ...experiment,
    execution,
    readiness: current
      ? experiment.readiness
      : (execution.readiness ?? "unknown"),
    blocking: current ? experiment.blocking : execution.blocking,
  };
}

function TemplateCategory({
  title,
  templates,
  summaries,
}: {
  title: string;
  templates: ReportTemplate[];
  summaries: Record<string, unknown>;
}) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium">{title}</div>
      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">None configured.</p>
      ) : (
        <div className="space-y-2">
          {templates.map((template) => {
            const summary = summaries[template.id];
            const status = handlerStatus(summary);
            const detail =
              summary && typeof summary === "object"
                ? (summary as Record<string, unknown>)
                : undefined;
            const matchingRunCount =
              typeof detail?.matchingRunCount === "number"
                ? detail.matchingRunCount
                : undefined;
            return (
              <div
                key={template.id}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <span>{template.name}</span>
                <Badge variant="secondary">v{template.currentVersion}</Badge>
                <Badge variant="outline">{status ?? "not scheduled"}</Badge>
                {matchingRunCount !== undefined && (
                  <span className="text-muted-foreground">
                    {matchingRunCount} matching run
                    {matchingRunCount === 1 ? "" : "s"}
                  </span>
                )}
                {handlerError(summary) && (
                  <span className="text-destructive">{handlerError(summary)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ExperimentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedRequestIds, setSelectedRequestIds] = useState<Set<string>>(new Set());
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(
    new Set(),
  );
  const selectedExecutionId = searchParams.get("executionId") ?? undefined;
  const selectedReportType = searchParams.get("reportType") ?? undefined;
  const selectedReportId =
    searchParams.get("reportId") ?? searchParams.get("report") ?? undefined;
  const requestedTab = searchParams.get("tab") ?? undefined;
  const [customizingColumns, setCustomizingColumns] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] =
    useState<RunSortColumn>("requestId");
  const [sortDirection, setSortDirection] =
    useState<SortDirection>("asc");
  const columnVisibility = useHiddenColumns({
    storageKey: "experiment-runs",
    defaultHidden: ["profile", "runId"],
  });
  const columnOrder = useColumnOrder({
    storageKey: "experiment-runs",
    columnIds: RUN_COLUMN_IDS,
  });
  const experimentQuery = useQuery({
    queryKey: ["experiment", id],
    queryFn: () => api.getExperiment(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const readiness = query.state.data?.readiness;
      return readiness === "done" ||
        readiness === "failed" ||
        readiness === "blocked"
        ? false
        : 5_000;
    },
  });
  const executionsQuery = useQuery({
    queryKey: ["experiment-executions", id],
    queryFn: () => api.listExperimentExecutions(id!, { limit: 100 }),
    enabled: Boolean(id) && experimentQuery.isSuccess,
  });
  const templatesQuery = useQuery({
    queryKey: ["report-templates", "experiment"],
    queryFn: () =>
      api.listReportTemplates({
        subject: "experiment",
        includeDisabled: true,
      }),
  });
  const currentExecutionId =
    experimentQuery.data?.execution.experimentExecutionId;
  const reportExecutionId = selectedExecutionId ?? currentExecutionId;
  const isViewingHistorical =
    Boolean(selectedExecutionId) &&
    selectedExecutionId !== currentExecutionId;
  const selectedExecutionQuery = useQuery({
    queryKey: ["experiment-execution", id, selectedExecutionId],
    queryFn: () => api.getExperimentExecution(id!, selectedExecutionId!),
    enabled: Boolean(id && selectedExecutionId && isViewingHistorical),
  });
  const reportsQuery = useQuery({
    queryKey: ["experiment-reports", id, reportExecutionId],
    queryFn: () => api.listExperimentReports(id!, reportExecutionId!),
    enabled: Boolean(id && reportExecutionId),
    refetchInterval: (query) => {
      const reports = query.state.data;
      if (
        reports &&
        reports.length > 0 &&
        reports.every(
          (report) =>
            report.status === "completed" || report.status === "failed",
        )
      ) {
        return false;
      }
      return 5_000;
    },
  });
  const retry = useMutation({
    mutationFn: () =>
      api.retryExperiment(
        experimentQuery.data!.experimentId,
        experimentQuery.data!.execution.experimentExecutionId,
      ),
    onSuccess: () => {
      toast.success("Experiment processing restarted");
      void queryClient.invalidateQueries({ queryKey: ["experiment", id] });
      void queryClient.invalidateQueries({
        queryKey: ["experiment-executions", id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["experiment-reports", id],
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Retry failed");
    },
  });
  const retryReport = useMutation({
    mutationFn: (templateId: string) =>
      api.retryExperimentReport(
        experimentQuery.data!.experimentId,
        experimentQuery.data!.execution.experimentExecutionId,
        templateId,
      ),
    onSuccess: () => {
      toast.success("Report retry queued");
      void queryClient.invalidateQueries({
        queryKey: ["experiment-reports", id],
      });
      void queryClient.invalidateQueries({ queryKey: ["experiment", id] });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Report retry failed",
      );
    },
  });
  const removeMembers = useMutation({
    mutationFn: () =>
      api.updateExperimentRequests("DELETE", experimentQuery.data!.experimentId, {
        expectedExperimentRevisionId:
          experimentQuery.data!.revision.experimentRevisionId,
        requestIds: [...selectedRequestIds],
      }),
    onSuccess: ({ experiment: nextExperiment, detachedRequestIds }) => {
      toast.success(
        `Removed ${detachedRequestIds.length} run${detachedRequestIds.length === 1 ? "" : "s"} · revision ${nextExperiment.revision.revisionNumber}`,
      );
      setSelectedRequestIds(new Set());
      setRemoveDialogOpen(false);
      queryClient.setQueryData(["experiment", id], nextExperiment);
      void queryClient.invalidateQueries({ queryKey: ["experiment-executions", id] });
      void queryClient.invalidateQueries({ queryKey: ["experiments"] });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("executionId");
          next.set("tab", "runs");
          next.delete("reportType");
          next.delete("reportId");
          next.delete("report");
          return next;
        },
        { replace: false },
      );
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Runs could not be removed");
    },
  });
  const updateTemplates = useMutation({
    mutationFn: () =>
      api.updateExperimentReportTemplates(experimentQuery.data!.experimentId, {
        expectedExperimentRevisionId:
          experimentQuery.data!.revision.experimentRevisionId,
        reportTemplateIds: [...selectedTemplateIds],
      }),
    onSuccess: (nextExperiment) => {
      toast.success(
        `Report configuration published as revision ${nextExperiment.revision.revisionNumber}`,
      );
      queryClient.setQueryData(["experiment", id], nextExperiment);
      void queryClient.invalidateQueries({
        queryKey: ["experiment-executions", id],
      });
      void queryClient.invalidateQueries({ queryKey: ["experiments"] });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Report configuration could not be updated",
      );
    },
  });

  useEffect(() => {
    setSelectedTemplateIds(
      new Set(experimentQuery.data?.revision.reportTemplateIds ?? []),
    );
  }, [
    experimentQuery.data?.revision.experimentRevisionId,
    experimentQuery.data?.revision.reportTemplateIds,
  ]);
  const manualTemplates = useMemo(
    () =>
      (templatesQuery.data ?? []).filter(
        (template: ReportTemplate) => !template.trigger,
      ),
    [templatesQuery.data],
  );
  const alwaysTemplates = useMemo(
    () =>
      (templatesQuery.data ?? []).filter(
        (template: ReportTemplate) => template.trigger?.type === "always",
      ),
    [templatesQuery.data],
  );
  const linkedTemplates = useMemo(
    () =>
      (templatesQuery.data ?? []).filter(
        (template: ReportTemplate) =>
          template.trigger?.type === "run-report-templates",
      ),
    [templatesQuery.data],
  );

  const attemptOptions = useMemo(() => {
    const byId = new Map<string, ExperimentExecutionView>();
    if (experimentQuery.data?.execution) {
      byId.set(
        experimentQuery.data.execution.experimentExecutionId,
        experimentQuery.data.execution,
      );
    }
    for (const execution of executionsQuery.data?.items ?? []) {
      byId.set(execution.experimentExecutionId, execution);
    }
    if (selectedExecutionQuery.data) {
      byId.set(
        selectedExecutionQuery.data.experimentExecutionId,
        selectedExecutionQuery.data,
      );
    }
    return [...byId.values()].sort(
      (left, right) => right.attemptNumber - left.attemptNumber,
    );
  }, [
    executionsQuery.data?.items,
    experimentQuery.data?.execution,
    selectedExecutionQuery.data,
  ]);

  const activeExecution = isViewingHistorical
    ? selectedExecutionQuery.data
    : experimentQuery.data?.execution;
  const activeExperiment =
    experimentQuery.data && activeExecution
      ? selectedExperimentView(experimentQuery.data, activeExecution)
      : undefined;
  const reportGroups = useMemo(
    () => groupExperimentReports(reportsQuery.data ?? []),
    [reportsQuery.data],
  );
  const reportSelection = useMemo(
    () =>
      resolveExperimentReportSelection(
        reportGroups,
        selectedReportType,
        selectedReportId,
      ),
    [reportGroups, selectedReportId, selectedReportType],
  );

  useEffect(() => {
    if (
      !selectedExecutionId ||
      !(selectedExecutionQuery.error instanceof ApiError) ||
      selectedExecutionQuery.error.status !== 404
    ) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete("executionId");
    next.delete("reportType");
    next.delete("reportId");
    next.delete("report");
    setSearchParams(next, { replace: true });
  }, [
    searchParams,
    selectedExecutionId,
    selectedExecutionQuery.error,
    setSearchParams,
  ]);

  const defaultTab: ExperimentDetailTab =
    reportSelection || reportsQuery.isError
    ? "reports"
    : activeExperiment &&
        ["waiting", "processing", "blocked"].includes(
          activeExperiment.readiness ?? "",
        )
      ? "processing"
      : "runs";
  const activeTab: ExperimentDetailTab = EXPERIMENT_DETAIL_TABS.includes(
    requestedTab as ExperimentDetailTab,
  )
    ? (requestedTab as ExperimentDetailTab)
    : defaultTab;

  useEffect(() => {
    if (
      !reportsQuery.isSuccess ||
      (selectedExecutionQuery.error instanceof ApiError &&
        selectedExecutionQuery.error.status === 404)
    ) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    let changed = false;

    if (
      selectedReportType &&
      selectedReportType !== reportSelection?.group.key
    ) {
      next.delete("reportType");
      changed = true;
    }
    if (selectedReportId && selectedReportId !== reportSelection?.report._id) {
      next.delete("reportId");
      next.delete("report");
      changed = true;
    } else if (searchParams.has("report") && reportSelection) {
      next.delete("report");
      next.set("reportId", reportSelection.report._id);
      changed = true;
    }
    if (
      requestedTab &&
      !EXPERIMENT_DETAIL_TABS.includes(requestedTab as ExperimentDetailTab)
    ) {
      next.delete("tab");
      changed = true;
    }

    if (changed) setSearchParams(next, { replace: true });
  }, [
    reportSelection,
    reportsQuery.isSuccess,
    searchParams,
    selectedReportId,
    selectedReportType,
    selectedExecutionQuery.error,
    requestedTab,
    setSearchParams,
  ]);

  const sortedRequests = useMemo(() => {
    if (!activeExecution) return [];
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...activeExecution.requests].sort((left, right) => {
      const compared = requestSortValue(left, sortColumn).localeCompare(
        requestSortValue(right, sortColumn),
        undefined,
        { numeric: true, sensitivity: "base" },
      );
      if (compared !== 0) return compared * direction;
      return left.requestId.localeCompare(right.requestId) * direction;
    });
  }, [activeExecution, sortColumn, sortDirection]);

  useEffect(() => {
    setPage(1);
  }, [activeExecution?.experimentExecutionId, pageSize, sortColumn, sortDirection]);

  useEffect(() => {
    setSelectedRequestIds(new Set());
    setRemoveDialogOpen(false);
  }, [activeExecution?.experimentExecutionId]);

  const pagedRequests = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedRequests.slice(start, start + pageSize);
  }, [page, pageSize, sortedRequests]);

  const columns = useMemo<DataTableColumn<ExperimentRequestSummaryView>[]>(() => {
    const naturalColumns: DataTableColumn<ExperimentRequestSummaryView>[] = [
      {
        id: "requestId",
        header: "ID",
        sortable: true,
        width: "120px",
        sticky: "left",
        cell: (request) => (
          <ShortId id={request.requestId} label="request ID" />
        ),
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        width: "110px",
        hidden: columnVisibility.isHidden("status"),
        cell: (request) =>
          request.status ? (
            <Badge variant="outline">{request.status}</Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: "outcome",
        header: "Outcome",
        sortable: true,
        width: "110px",
        hidden: columnVisibility.isHidden("outcome"),
        cell: (request) =>
          request.outcome ? (
            <Badge variant="secondary">{request.outcome}</Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: "task",
        header: "Task",
        sortable: true,
        hidden: columnVisibility.isHidden("task"),
        cell: (request) => (
          <span className="block max-w-[360px] truncate text-sm">
            {request.task ? truncate(request.task, 80) : "—"}
          </span>
        ),
      },
      {
        id: "worker",
        header: "Worker",
        sortable: true,
        width: "180px",
        hidden: columnVisibility.isHidden("worker"),
        cell: (request) => (
          <span className="font-mono text-xs">
            {request.workerType ?? "—"}
          </span>
        ),
      },
      {
        id: "model",
        header: "Model",
        sortable: true,
        width: "180px",
        hidden: columnVisibility.isHidden("model"),
        cell: (request) => (
          <span className="font-mono text-xs">{request.model ?? "—"}</span>
        ),
      },
      {
        id: "profile",
        header: "Profile",
        sortable: true,
        width: "150px",
        hidden: columnVisibility.isHidden("profile"),
        cell: (request) => (
          <span className="font-mono text-xs">
            {request.profileId ?? "—"}
          </span>
        ),
      },
      {
        id: "runId",
        header: "Run ID",
        sortable: true,
        width: "120px",
        hidden: columnVisibility.isHidden("runId"),
        cell: (request) => <ShortId id={request.runId} label="run ID" />,
      },
    ];
    const byId = new Map(naturalColumns.map((column) => [column.id, column]));
    return columnOrder.order
      .map((columnId) => byId.get(columnId))
      .filter(
        (
          column,
        ): column is DataTableColumn<ExperimentRequestSummaryView> =>
          Boolean(column),
      );
  }, [columnOrder.order, columnVisibility]);

  const selectExecution = (executionId: string) => {
    const next = new URLSearchParams(searchParams);
    if (executionId === currentExecutionId) {
      next.delete("executionId");
    } else {
      next.set("executionId", executionId);
    }
    next.delete("reportType");
    next.delete("reportId");
    next.delete("report");
    setSearchParams(next, { replace: true });
  };

  const selectReportType = (typeKey: string) => {
    const group = reportGroups.find((candidate) => candidate.key === typeKey);
    if (!group) return;
    const next = new URLSearchParams(searchParams);
    next.set("reportType", group.key);
    next.set("reportId", group.reports[0]._id);
    next.delete("report");
    setSearchParams(next, { replace: true });
  };

  const selectReportVersion = (reportId: string) => {
    if (!reportSelection) return;
    const next = new URLSearchParams(searchParams);
    next.set("reportType", reportSelection.group.key);
    next.set("reportId", reportId);
    next.delete("report");
    setSearchParams(next, { replace: true });
  };

  const selectTab = (value: string) => {
    if (!EXPERIMENT_DETAIL_TABS.includes(value as ExperimentDetailTab)) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", value);
    setSearchParams(next, { replace: true });
  };

  const changeSort = (column: string) => {
    if (!RUN_COLUMN_IDS.includes(column)) return;
    const nextColumn = column as RunSortColumn;
    if (nextColumn === sortColumn) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(nextColumn);
    setSortDirection("asc");
  };

  if (experimentQuery.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Loading experiment…
      </div>
    );
  }
  if (experimentQuery.isError || !experimentQuery.data) {
    const correlationOnly =
      experimentQuery.error instanceof ApiError &&
      experimentQuery.error.status === 404;
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
        <Button variant="ghost" size="sm" asChild className="-ml-3">
          <Link to="/experiments">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Experiments
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {correlationOnly
                ? "Historical experiment correlation"
                : "Experiment could not be loaded"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            {correlationOnly ? (
              <>
                <p>
                  <span className="font-mono text-foreground">{id}</span> is
                  attached to historical runs but has no canonical Experiment
                  document.
                </p>
                <p>
                  This correlation is view-only. It cannot be retried or used to
                  trigger processing.
                </p>
              </>
            ) : (
              <p className="text-destructive">
                {experimentQuery.error instanceof Error
                  ? experimentQuery.error.message
                  : "The experiment request failed."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const experiment = experimentQuery.data;
  const canRetry = !["waiting", "processing"].includes(
    experiment.readiness ?? "",
  );
  const selectedValue =
    activeExecution?.experimentExecutionId ??
    selectedExecutionId ??
    experiment.execution.experimentExecutionId;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-6">
      <header
        className="flex flex-wrap items-start justify-between gap-4"
        data-slot="experiment-detail-header"
      >
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-3 mb-1">
            <Link to="/experiments">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Experiments
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">
              {experiment.metadata.name}
            </h1>
            <ShortId id={experiment.experimentId} label="experiment ID" />
            <Badge
              variant={
                experiment.readiness === "failed" ||
                experiment.readiness === "blocked"
                  ? "destructive"
                  : "secondary"
              }
            >
              {experiment.readiness ?? "unknown"}
            </Badge>
            {isViewingHistorical && (
              <Badge variant="outline">Historical attempt</Badge>
            )}
          </div>
          {experiment.metadata.description && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {experiment.metadata.description}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label
              htmlFor="experiment-attempt"
              className="block text-xs font-medium text-muted-foreground"
            >
              Processing attempt
            </label>
            <Select value={selectedValue} onValueChange={selectExecution}>
              <SelectTrigger
                id="experiment-attempt"
                aria-label="Experiment attempt"
                className="w-[230px]"
              >
                <Clock className="mr-2 h-4 w-4" />
                <SelectValue placeholder="Select attempt" />
              </SelectTrigger>
              <SelectContent align="end">
                {attemptOptions.map((execution) => {
                  const current =
                    execution.experimentExecutionId === currentExecutionId;
                  return (
                    <SelectItem
                      key={execution.experimentExecutionId}
                      value={execution.experimentExecutionId}
                    >
                      Attempt {execution.attemptNumber}
                      {current ? " · current" : " · historical"}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      {selectedExecutionQuery.isLoading && isViewingHistorical && (
        <p className="text-sm text-muted-foreground">
          Loading processing attempt…
        </p>
      )}
      {selectedExecutionQuery.isError && isViewingHistorical && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">
            {selectedExecutionQuery.error instanceof Error
              ? selectedExecutionQuery.error.message
              : "The selected processing attempt could not be loaded."}
          </CardContent>
        </Card>
      )}

      {activeExperiment && activeExecution && (
        <Tabs value={activeTab} onValueChange={selectTab}>
          <TabsList aria-label="Experiment detail sections">
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
            <TabsTrigger value="processing">Processing</TabsTrigger>
          </TabsList>

          <TabsContent value="runs" className="mt-4">
            <Card>
              <CardContent className="p-6">
                <EmbeddedTableBlock
                  title={`Runs in attempt ${activeExecution.attemptNumber}`}
                  description={
                    isViewingHistorical
                      ? "Open a row to inspect the exact request/run pair captured by this historical processing attempt."
                      : `Revision ${experiment.revision.revisionNumber} · ${experiment.revision.memberCount} current members. Select runs to remove them in one new revision.`
                  }
                  actions={
                    <div className="flex flex-wrap items-center gap-2">
                      {!isViewingHistorical && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            selectedRequestIds.size === 0 ||
                            removeMembers.isPending
                          }
                          onClick={() => setRemoveDialogOpen(true)}
                        >
                          <Unlink className="mr-2 h-4 w-4" />
                          Remove
                          {selectedRequestIds.size > 0
                            ? ` (${selectedRequestIds.size})`
                            : ""}
                        </Button>
                      )}
                      <CustomizeColumnsLink
                        onClick={() => setCustomizingColumns((open) => !open)}
                      />
                    </div>
                  }
                >
                  <div className="flex min-h-0 items-start gap-3">
                    {customizingColumns && (
                      <CustomizeColumnsPanel
                        columns={RUN_COLUMN_OPTIONS}
                        hidden={columnVisibility.hidden}
                        onToggle={columnVisibility.toggle}
                        onSetHidden={columnVisibility.setHidden}
                        onReset={() => {
                          columnVisibility.reset();
                          columnOrder.reset();
                        }}
                        onClose={() => setCustomizingColumns(false)}
                        order={columnOrder.order}
                        onReorder={columnOrder.setOrder}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <DataTable
                        items={pagedRequests}
                        columns={columns}
                        getRowId={(request) => request.requestId}
                        onRowClick={(request) =>
                          navigate(
                            `/runs/${request.requestId}?runId=${encodeURIComponent(request.runId)}`,
                          )
                        }
                        sort={sortColumn}
                        sortDir={sortDirection}
                        onSortChange={changeSort}
                        density="compact"
                        selection={
                          isViewingHistorical
                            ? undefined
                            : {
                                selectedIds: selectedRequestIds,
                                onToggle: (requestId) =>
                                  setSelectedRequestIds((current) => {
                                    const id = String(requestId);
                                    const next = new Set(current);
                                    if (next.has(id)) next.delete(id);
                                    else next.add(id);
                                    return next;
                                  }),
                                onToggleAll: (requestIds) =>
                                  setSelectedRequestIds((current) => {
                                    const next = new Set(current);
                                    const ids = requestIds.map(String);
                                    const allSelected = ids.every((requestId) =>
                                      next.has(requestId)
                                    );
                                    for (const requestId of ids) {
                                      if (allSelected) next.delete(requestId);
                                      else next.add(requestId);
                                    }
                                    return next;
                                  }),
                              }
                        }
                        emptyState={
                          <div className="py-6 text-sm text-muted-foreground">
                            {activeExecution.requestCount === 0
                              ? "This processing attempt has no runs."
                              : `${activeExecution.requestCount} linked runs are stored outside the resolved response.`}
                          </div>
                        }
                      />
                      {sortedRequests.length > 0 && (
                        <Pagination
                          page={page}
                          pageSize={pageSize}
                          total={sortedRequests.length}
                          pageSizeOptions={[10, 25, 50]}
                          onPageChange={setPage}
                          onPageSizeChange={setPageSize}
                          itemLabel="runs"
                          className="px-1 pt-2"
                        />
                      )}
                    </div>
                  </div>
                </EmbeddedTableBlock>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="reports" className="mt-4">
            <ExperimentReportCard
              experimentId={experiment.experimentId}
              experimentExecutionId={activeExecution.experimentExecutionId}
              attemptNumber={activeExecution.attemptNumber}
              groups={reportGroups}
              selection={reportSelection}
              structuredUrl={
                reportSelection?.report.structuredArtifact
                  ? api.experimentReportStructuredUrl(
                      experiment.experimentId,
                      activeExecution.experimentExecutionId,
                      reportSelection.report._id,
                    )
                  : undefined
              }
              isLoading={reportsQuery.isLoading}
              error={
                reportsQuery.isError
                  ? reportsQuery.error instanceof Error
                    ? reportsQuery.error.message
                    : "Report could not be loaded."
                  : undefined
              }
              isProcessing={
                ["queued", "processing"].includes(
                  handlerStatus(
                    activeExecution.handlerProgress["pp-readout"],
                  ) ?? "",
                ) &&
                activeExecution.readiness !== "failed" &&
                activeExecution.readiness !== "blocked"
              }
              isBlocked={activeExecution.readiness === "blocked"}
              onReportTypeChange={selectReportType}
              onReportVersionChange={selectReportVersion}
              onRetry={() => {
                const templateId = reportSelection?.report.templateId;
                if (templateId && !isViewingHistorical) {
                  retryReport.mutate(templateId);
                  return;
                }
                void reportsQuery.refetch();
              }}
            />
          </TabsContent>

          <TabsContent value="processing" className="mt-4 space-y-4">
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => retry.mutate()}
                disabled={retry.isPending || !canRetry || isViewingHistorical}
                title={
                  isViewingHistorical
                    ? "Return to the current attempt to retry processing"
                    : undefined
                }
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Retry processing
              </Button>
            </div>
            <ExperimentStatusCard experiment={activeExperiment} />
            {!isViewingHistorical && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Report templates</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <p className="text-sm text-muted-foreground">
                    Changing selectable reports publishes a new immutable Experiment
                    revision. Automatic reports run after the built-in readout.
                  </p>
                  <div>
                    <div className="mb-2 text-sm font-medium">
                      Selectable manual reports
                    </div>
                    <div className="space-y-2">
                      {manualTemplates.map((template) => (
                        <label
                          key={template.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={selectedTemplateIds.has(template.id)}
                            disabled={!template.enabled}
                            onChange={() =>
                              setSelectedTemplateIds((current) => {
                                const next = new Set(current);
                                if (next.has(template.id)) next.delete(template.id);
                                else next.add(template.id);
                                return next;
                              })
                            }
                          />
                          <span>{template.name}</span>
                          <Badge variant="secondary">v{template.currentVersion}</Badge>
                          {!template.enabled && (
                            <Badge variant="outline">Unavailable</Badge>
                          )}
                        </label>
                      ))}
                      {manualTemplates.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          No selectable Experiment report templates.
                        </p>
                      )}
                    </div>
                    <Button
                      className="mt-3"
                      size="sm"
                      onClick={() => updateTemplates.mutate()}
                      disabled={updateTemplates.isPending}
                    >
                      {updateTemplates.isPending
                        ? "Publishing revision…"
                        : "Publish report configuration"}
                    </Button>
                  </div>
                  <TemplateCategory
                    title="Automatic always"
                    templates={alwaysTemplates}
                    summaries={activeExecution.reportTemplates ?? {}}
                  />
                  <TemplateCategory
                    title="Automatic linked-run"
                    templates={linkedTemplates}
                    summaries={activeExecution.reportTemplates ?? {}}
                  />
                </CardContent>
              </Card>
            )}
            <ExecutionSummary
              execution={activeExecution}
              current={!isViewingHistorical}
            />
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Handler progress</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(activeExecution.handlerProgress).length ===
                0 ? (
                  <p className="text-sm text-muted-foreground">
                    No handlers are registered for this attempt.
                  </p>
                ) : (
                  Object.entries(activeExecution.handlerProgress).map(
                    ([handlerId, progress]) => (
                      <div
                        key={handlerId}
                        className="flex flex-wrap items-center gap-2 text-sm"
                      >
                        <span className="font-mono text-xs">{handlerId}</span>
                        <Badge variant="outline">
                          {handlerStatus(progress) ?? "unknown"}
                        </Badge>
                        {handlerError(progress) && (
                          <span className="text-destructive">
                            {handlerError(progress)}
                          </span>
                        )}
                      </div>
                    ),
                  )
                )}
              </CardContent>
            </Card>
            {activeExperiment.blocking.length > 0 && (
              <Card className="border-destructive/40">
                <CardHeader>
                  <CardTitle className="text-base">
                    Blocking dependencies
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {activeExperiment.blocking.map((blocking, index) => (
                    <div
                      key={`${blocking.handlerId}:${blocking.requestId ?? index}`}
                      className="flex flex-wrap items-center gap-2 text-sm"
                    >
                      {blocking.requestId && (
                        <Link
                          to={`/runs/${blocking.requestId}${
                            blocking.runId
                              ? `?runId=${encodeURIComponent(blocking.runId)}`
                              : ""
                          }`}
                          className="font-mono text-primary hover:underline"
                        >
                          {blocking.requestId.slice(0, 8)}
                        </Link>
                      )}
                      <Badge variant="destructive">{blocking.reason}</Badge>
                      <span className="font-mono text-xs text-muted-foreground">
                        {blocking.handlerId}
                      </span>
                      {blocking.error && <span>{blocking.error}</span>}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      )}

      <AlertDialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {selectedRequestIds.size} run
              {selectedRequestIds.size === 1 ? "" : "s"} from this Experiment?
            </AlertDialogTitle>
            <AlertDialogDescription>
              One membership request will publish a new immutable revision based
              on revision {experiment.revision.revisionNumber}. The runs
              themselves will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                removeMembers.mutate();
              }}
              disabled={
                removeMembers.isPending ||
                selectedRequestIds.size === 0 ||
                isViewingHistorical
              }
            >
              {removeMembers.isPending ? "Removing…" : "Remove runs"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
