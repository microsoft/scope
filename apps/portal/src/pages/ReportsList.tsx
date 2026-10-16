// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useLocation, useOutlet, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate, formatId, truncate } from "@/lib/utils";
import { REPORT_STATUS_LIST } from "@/types";
import type { Report } from "@/types";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,
  DataTable,
  Pagination,
  CustomizeColumnsPanel,
  CustomizeColumnsLink,
  useHiddenColumns,
  useListUrlState,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";

const FILTER_KEYS = ["status"] as const;

export function ReportsList() {
  const navigate = useNavigate();
  const location = useLocation();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const columnVisibility = useHiddenColumns({ storageKey: "reports", defaultHidden: [] });

  const { data: reports = [], isLoading } = useQuery({
    queryKey: ["reports"],
    queryFn: () => api.listReports(),
    refetchInterval: 10_000,
  });

  const statusOptions = useMemo(
    () =>
      REPORT_STATUS_LIST.map((s) => ({
        value: s,
        label: s,
        count: reports.filter((r) => r.status === s).length,
      })),
    [reports],
  );

  const filteredReports = useMemo(() => {
    const statuses = state.getFilterList("status");
    const q = state.search.trim().toLowerCase();
    return reports.filter((r) => {
      if (statuses.length > 0 && !statuses.includes(r.status)) return false;
      if (q) {
        const blob = `${r._id} ${r.task ?? ""}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [reports, state]);

  const sortedReports = useMemo(() => {
    if (!state.sort) return filteredReports;
    const sorted = [...filteredReports];
    sorted.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredReports, state.sort, state.sortDir]);

  const total = sortedReports.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedReports.slice(pageStart, pageStart + state.pageSize);

  const columnOptions: CustomizeColumnsOption[] = [
    { id: "id", label: "ID", required: true },
    { id: "task", label: "Task" },
    { id: "runId", label: "Subject" },
    { id: "status", label: "Status" },
    { id: "template", label: "Template" },
    { id: "model", label: "Model" },
    { id: "created", label: "Created" },
  ];

  const columns: DataTableColumn<Report>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "120px",
      cell: (r) => <span className="font-mono text-xs">{formatId(r._id)}</span>,
    },
    {
      id: "task",
      header: "Task",
      hidden: columnVisibility.isHidden("task"),
      cell: (r) => (
        <span className="text-sm" title={r.task}>
          {truncate(r.task ?? "—", 60)}
        </span>
      ),
    },
    {
      id: "runId",
      header: "Subject",
      width: "120px",
      hidden: columnVisibility.isHidden("runId"),
      cell: (r) => r.submissionId ? (
        <span
          className="font-mono text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={(event) => {
            event.stopPropagation();
            navigate(`/submissions/${r.submissionId}`);
          }}
        >
          Submission {formatId(r.submissionId)}
        </span>
      ) : r.requestId ? (
        <span
          className="font-mono text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={(event) => {
            event.stopPropagation();
            navigate(`/runs/${r.requestId}`);
          }}
        >
          Run {formatId(r.requestId)}
        </span>
      ) : <span className="text-xs text-muted-foreground">—</span>,
    },
    {
      id: "status",
      header: "Status",
      width: "120px",
      hidden: columnVisibility.isHidden("status"),
      cell: (r) => <ReportStatusBadge status={r.status} />,
    },
    {
      id: "template",
      header: "Template",
      width: "100px",
      hidden: columnVisibility.isHidden("template"),
      cell: (r) =>
        r.templateId ? (
          <Badge
            variant="outline"
            className="text-xs font-mono hover:bg-accent cursor-pointer"
            onClick={(e) => { e.stopPropagation(); navigate(`/reports/templates/${r.templateId}`); }}
          >
            {r.templateId}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">
            {r.submissionId ? "template-less" : "default"}
          </span>
        ),
    },
    {
      id: "model",
      header: "Model",
      width: "100px",
      hidden: columnVisibility.isHidden("model"),
      cell: (r) => (
        <span className="text-sm text-muted-foreground">{r.reporter?.model ?? "—"}</span>
      ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      hidden: columnVisibility.isHidden("created"),
      cell: (r) => <span className="text-xs text-muted-foreground">{formatDate(r.createdAt)}</span>,
    },
  ];

  const activeTab = location.pathname.startsWith("/reports/templates") ? "templates" : "reports";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 px-6 pt-3">
        <Tabs
          value={activeTab}
          onValueChange={(v) => navigate(v === "templates" ? "/reports/templates" : "/reports")}
        >
          <TabsList>
            <TabsTrigger value="reports">Reports</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1">
        <ListLayout
          title="Reports"
          description="Generated analysis reports for benchmark runs and submissions"
          railStorageKey="reports"
          filterRail={
            <FilterRail
              search={state.search}
              onSearchChange={state.setSearch}
              searchPlaceholder="Search reports…"
              footer={
                <>
                  <ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} />
                  <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
                </>
              }
            >
              <FilterSection title="Status" storageKey="reports-status">
                <CheckboxFilterGroup
                  options={statusOptions}
                  selected={state.getFilterList("status")}
                  onToggle={(v) => state.toggleFilterValue("status", v)}
                />
              </FilterSection>
            </FilterRail>
          }
          secondaryPanel={
            customizeOpen ? (
              <CustomizeColumnsPanel
                columns={columnOptions}
                hidden={columnVisibility.hidden}
                onToggle={columnVisibility.toggle}
                onSetHidden={columnVisibility.setHidden}
                onReset={columnVisibility.reset}
                onClose={() => setCustomizeOpen(false)}
              />
            ) : null
          }
          onSecondaryClose={() => setCustomizeOpen(false)}
          detail={detailOutlet}
          onDetailClose={() =>
            navigate({ pathname: "/reports", search: window.location.search })
          }
        >
          <div className="flex flex-col gap-3">
            <DataTable
              items={pageItems}
              columns={columns}
              getRowId={(r) => r._id}
              activeId={activeId}
              onRowClick={(r) =>
                navigate({ pathname: `/reports/${r._id}/preview`, search: window.location.search })
              }
              sort={state.sort}
              sortDir={state.sortDir}
              onSortChange={state.toggleSort}
              loading={isLoading}
              loadingRows={state.pageSize}
              emptyState={
                state.hasActiveFilters
                  ? "No reports match your filters"
                  : "No reports yet. Reports are automatically generated when benchmark runs complete."
              }
            />
            <Pagination
              page={state.page}
              pageSize={state.pageSize}
              total={total}
              onPageChange={state.setPage}
              onPageSizeChange={state.setPageSize}
              itemLabel="reports"
            />
          </div>
        </ListLayout>
      </div>
    </div>
  );
}

function sortKey(r: Report, col: string): string | number {
  switch (col) {
    case "id":
      return r._id;
    case "created":
      return new Date(r.createdAt).getTime();
    default:
      return "";
  }
}
