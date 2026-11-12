// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Atom, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import {
  CheckboxFilterGroup,
  ClearFiltersLink,
  CustomizeColumnsLink,
  CustomizeColumnsPanel,
  DataTable,
  FilterRail,
  FilterSection,
  ListLayout,
  Pagination,
  useColumnOrder,
  useHiddenColumns,
  useListUrlState,
  type CustomizeColumnsOption,
  type DataTableColumn,
} from "@/components/list-layout";
import { ShortId } from "@/components/ShortId";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { ExperimentView } from "@/lib/experiments";
import { formatDate } from "@/lib/utils";

const FILTER_KEYS = ["readiness"] as const;
const READINESS_VALUES = [
  "waiting",
  "processing",
  "done",
  "blocked",
  "failed",
] as const;
const COLUMN_OPTIONS: CustomizeColumnsOption[] = [
  { id: "name", label: "Experiment", required: true },
  { id: "readiness", label: "Status" },
  { id: "runs", label: "Runs" },
  { id: "revision", label: "Revision" },
  { id: "attempt", label: "Attempt" },
  { id: "created", label: "Created" },
  { id: "id", label: "ID" },
];
const COLUMN_IDS = COLUMN_OPTIONS.map((column) => column.id);

type ExperimentSortColumn = (typeof COLUMN_IDS)[number];

function readinessVariant(readiness?: string) {
  return readiness === "failed" || readiness === "blocked"
    ? "destructive"
    : "secondary";
}

function sortValue(
  experiment: ExperimentView,
  column: ExperimentSortColumn,
): string | number {
  switch (column) {
    case "name":
      return experiment.metadata.name;
    case "readiness":
      return experiment.readiness ?? "";
    case "runs":
      return experiment.revision.memberCount;
    case "revision":
      return experiment.revision.revisionNumber;
    case "attempt":
      return experiment.execution.attemptNumber;
    case "created":
      return new Date(experiment.createdAt).getTime();
    case "id":
      return experiment.experimentId;
    default:
      return "";
  }
}

export function ExperimentsList() {
  const navigate = useNavigate();
  const state = useListUrlState({
    defaultPageSize: 25,
    filterKeys: FILTER_KEYS,
  });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const columnVisibility = useHiddenColumns({
    storageKey: "experiments",
    defaultHidden: ["id"],
  });
  const columnOrder = useColumnOrder({
    storageKey: "experiments",
    columnIds: COLUMN_IDS,
  });
  const cursor = cursorStack[state.page - 1];
  const experimentsQuery = useQuery({
    queryKey: ["experiments", cursor, state.pageSize],
    queryFn: () =>
      api.listExperiments({ cursor, limit: state.pageSize }),
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    setCursorStack([undefined]);
  }, [state.pageSize]);

  const readinessOptions = useMemo(
    () =>
      READINESS_VALUES.map((readiness) => ({
        value: readiness,
        label: readiness,
        count:
          experimentsQuery.data?.items.filter(
            (experiment) => experiment.readiness === readiness,
          ).length ?? 0,
      })),
    [experimentsQuery.data?.items],
  );

  const filteredExperiments = useMemo(() => {
    const selectedReadiness = state.getFilterList("readiness");
    const search = state.search.trim().toLocaleLowerCase();
    return (experimentsQuery.data?.items ?? []).filter((experiment) => {
      if (
        selectedReadiness.length > 0 &&
        !selectedReadiness.includes(experiment.readiness ?? "unknown")
      ) {
        return false;
      }
      if (!search) return true;
      return [
        experiment.metadata.name,
        experiment.metadata.description,
        experiment.experimentId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(search);
    });
  }, [experimentsQuery.data?.items, state]);

  const sortedExperiments = useMemo(() => {
    if (!state.sort || !COLUMN_IDS.includes(state.sort)) {
      return filteredExperiments;
    }
    const column = state.sort as ExperimentSortColumn;
    const direction = state.sortDir === "asc" ? 1 : -1;
    return [...filteredExperiments].sort((left, right) => {
      const leftValue = sortValue(left, column);
      const rightValue = sortValue(right, column);
      const compared =
        typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue), undefined, {
              numeric: true,
              sensitivity: "base",
            });
      if (compared !== 0) return compared * direction;
      return left.experimentId.localeCompare(right.experimentId) * direction;
    });
  }, [filteredExperiments, state.sort, state.sortDir]);

  const columns = useMemo<DataTableColumn<ExperimentView>[]>(() => {
    const naturalColumns: DataTableColumn<ExperimentView>[] = [
      {
        id: "name",
        header: "Experiment",
        sortable: true,
        sticky: "left",
        cell: (experiment) => (
          <div className="flex min-w-0 items-center gap-2">
            <Atom
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {experiment.metadata.name}
              </div>
              {experiment.metadata.description && (
                <div className="max-w-[420px] truncate text-xs text-muted-foreground">
                  {experiment.metadata.description}
                </div>
              )}
            </div>
          </div>
        ),
      },
      {
        id: "readiness",
        header: "Status",
        sortable: true,
        width: "120px",
        hidden: columnVisibility.isHidden("readiness"),
        cell: (experiment) => (
          <Badge variant={readinessVariant(experiment.readiness)}>
            {experiment.readiness ?? "unknown"}
          </Badge>
        ),
      },
      {
        id: "runs",
        header: "Runs",
        sortable: true,
        width: "90px",
        align: "right",
        hidden: columnVisibility.isHidden("runs"),
        cell: (experiment) => experiment.revision.memberCount,
      },
      {
        id: "revision",
        header: "Revision",
        sortable: true,
        width: "100px",
        align: "right",
        hidden: columnVisibility.isHidden("revision"),
        cell: (experiment) => experiment.revision.revisionNumber,
      },
      {
        id: "attempt",
        header: "Attempt",
        sortable: true,
        width: "100px",
        align: "right",
        hidden: columnVisibility.isHidden("attempt"),
        cell: (experiment) => experiment.execution.attemptNumber,
      },
      {
        id: "created",
        header: "Created",
        sortable: true,
        width: "170px",
        hidden: columnVisibility.isHidden("created"),
        cell: (experiment) => (
          <span className="text-xs text-muted-foreground">
            {formatDate(experiment.createdAt)}
          </span>
        ),
      },
      {
        id: "id",
        header: "ID",
        sortable: true,
        width: "120px",
        hidden: columnVisibility.isHidden("id"),
        cell: (experiment) => (
          <ShortId id={experiment.experimentId} label="experiment ID" />
        ),
      },
    ];
    const byId = new Map(naturalColumns.map((column) => [column.id, column]));
    return columnOrder.order
      .map((columnId) => byId.get(columnId))
      .filter(
        (column): column is DataTableColumn<ExperimentView> => Boolean(column),
      );
  }, [columnOrder.order, columnVisibility]);

  const handlePageChange = (nextPage: number) => {
    if (nextPage === state.page) return;
    if (nextPage === 1) {
      state.setPage(1);
      return;
    }
    if (nextPage === state.page + 1) {
      const nextCursor = experimentsQuery.data?.nextCursor;
      if (!nextCursor) return;
      setCursorStack((current) => {
        const next = [...current];
        next[nextPage - 1] = nextCursor;
        return next;
      });
      state.setPage(nextPage);
      return;
    }
    if (nextPage === state.page - 1 && cursorStack[nextPage - 1] !== undefined) {
      state.setPage(nextPage);
    }
  };

  const emptyState = state.hasActiveFilters ? (
    "No experiments on this page match the current filters."
  ) : (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <Atom className="h-8 w-8 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">No experiments yet</p>
        <p className="text-sm text-muted-foreground">
          Create one from a scenario, or leave the scenario empty to create a
          durable placeholder.
        </p>
      </div>
    </div>
  );

  return (
    <ListLayout
      title="Experiments"
      description="Reproducible benchmark compositions and processing history"
      railStorageKey="experiments"
      actions={
        <Button asChild>
          <Link to="/experiments/new">
            <Plus className="mr-2 h-4 w-4" />
            New Experiment
          </Link>
        </Button>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search experiments…"
          refreshing={experimentsQuery.isFetching}
          footer={
            <>
              <ClearFiltersLink
                onClick={state.clearFilters}
                disabled={!state.hasActiveFilters}
              />
              <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
            </>
          }
        >
          <FilterSection
            title="Status"
            storageKey="experiments-readiness"
          >
            <CheckboxFilterGroup
              options={readinessOptions}
              selected={state.getFilterList("readiness")}
              onToggle={(value) =>
                state.toggleFilterValue("readiness", value)
              }
            />
          </FilterSection>
        </FilterRail>
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
        {experimentsQuery.isError ? (
          <p className="text-sm text-destructive">
            {experimentsQuery.error instanceof Error
              ? experimentsQuery.error.message
              : "Experiments could not be loaded."}
          </p>
        ) : (
          <>
            <DataTable
              items={sortedExperiments}
              columns={columns}
              getRowId={(experiment) => experiment.experimentId}
              onRowClick={(experiment) =>
                navigate(`/experiments/${experiment.experimentId}`)
              }
              sort={state.sort}
              sortDir={state.sortDir}
              onSortChange={state.toggleSort}
              loading={experimentsQuery.isLoading}
              loadingRows={state.pageSize}
              emptyState={emptyState}
            />
            <Pagination
              page={state.page}
              pageSize={state.pageSize}
              onPageChange={handlePageChange}
              onPageSizeChange={state.setPageSize}
              hasNext={Boolean(experimentsQuery.data?.nextCursor)}
              hasPrev={state.page > 1}
              itemLabel="experiments"
            />
          </>
        )}
      </div>
    </ListLayout>
  );
}
