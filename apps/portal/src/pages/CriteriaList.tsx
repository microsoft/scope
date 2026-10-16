// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useOutlet, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { CriteriaDocument } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Eye, GitBranch, Download } from "lucide-react";
import { truncate } from "@/lib/utils";
import { criteriaToExportYaml, downloadAsFile } from "@/lib/criteria-export";
import { formatGateList, GATE_METADATA, isCriterionCompatibleWithGate, type GateId } from "@/lib/gates";
import { useVisibleGates } from "@/hooks/useVisibleGates";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,
  CustomizeColumnsLink,
  CustomizeColumnsPanel,
  DataTable,
  Pagination,
  BulkActionBar,
  useHiddenColumns,
  useListUrlState,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";
import { HelpTooltip } from "@/components/HelpTooltip";
import { CriteriaKindBadge, CriteriaSubjectBadge } from "@/components/CriteriaBadge";
import { TAXONOMY_ELEMENT_METADATA } from "@/types";

const FILTER_KEYS = ["gate", "kind"] as const;

const COLUMN_OPTIONS: CustomizeColumnsOption[] = [
  { id: "id", label: "ID", required: true },
  { id: "prompt", label: "Prompt" },
  { id: "kind", label: "Kind" },
  { id: "taxonomy", label: "Dimension" },
  { id: "gates", label: "Gates" },
  { id: "dependencies", label: "Dependencies" },
  { id: "actions", label: "Actions" },
];

export function CriteriaList() {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const visibility = useHiddenColumns({ storageKey: "criteria" });
  const visibleGates = useVisibleGates();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: criteria = [], isLoading } = useQuery({
    queryKey: ["criteria", state.search],
    queryFn: () => api.listCriteria(state.search || undefined),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteCriterion,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["criteria"] }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteCriterion(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(
        `Deleted ${deleted} criterion${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed (likely has dependents)` : ""}`,
      );
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const sortedCriteria = useMemo(() => {
    const selectedGates = state.getFilterList("gate") as GateId[];
    const selectedKinds = state.getFilterList("kind");
    // A criterion matches if it is compatible with any selected gate (OR).
    // Criteria with no explicit gates are compatible with every gate.
    const gateFiltered =
      selectedGates.length === 0
        ? criteria
        : criteria.filter((c) => (c.kind ?? "gate") === "gate" && selectedGates.some((g) => isCriterionCompatibleWithGate(c.gates, g)));
    const filtered =
      selectedKinds.length === 0
        ? gateFiltered
        : gateFiltered.filter((c) => selectedKinds.includes(c.kind ?? "gate"));
    if (!state.sort) return filtered;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [criteria, state.sort, state.sortDir, state]);

  const gateFilterOptions = useMemo(
    () =>
      visibleGates.map((gate) => ({
        value: gate,
        label: GATE_METADATA[gate].label,
        count: criteria.filter((c) => (c.kind ?? "gate") === "gate" && isCriterionCompatibleWithGate(c.gates, gate)).length,
      })),
    [criteria, visibleGates],
  );

  const kindFilterOptions = useMemo(
    () => [
      { value: "gate", label: "Gate", count: criteria.filter((c) => (c.kind ?? "gate") === "gate").length },
      { value: "observation", label: "Observation", count: criteria.filter((c) => c.kind === "observation").length },
    ],
    [criteria],
  );

  const total = sortedCriteria.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedCriteria.slice(pageStart, pageStart + state.pageSize);

  const toggleRow = useCallback((id: Key) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleAll = useCallback((ids: Key[]) => {
    setSelectedIds((prev) => {
      const stringIds = ids.map((id) => String(id));
      const allSelected = stringIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) for (const id of stringIds) next.delete(id);
      else for (const id of stringIds) next.add(id);
      return next;
    });
  }, []);

  const columns: DataTableColumn<CriteriaDocument>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "200px",
      hidden: visibility.isHidden("id"),
      cell: (c) => (
        <CriteriaBadge criterionId={c.id} prompt={c.prompt} />
      ),
    },
    {
      id: "prompt",
      header: "Prompt",
      hidden: visibility.isHidden("prompt"),
      cell: (c) => (
        <span className="text-sm text-muted-foreground">{truncate(c.prompt, 100)}</span>
      ),
    },
    {
      id: "kind",
      header: "Kind",
      width: "180px",
      hidden: visibility.isHidden("kind"),
      cell: (c) => (
        <div className="flex flex-wrap items-center gap-1">
          <CriteriaKindBadge kind={c.kind} />
          {c.kind === "observation" && <CriteriaSubjectBadge subject={c.subject} />}
        </div>
      ),
    },
    {
      id: "taxonomy",
      header: "Dimension",
      width: "190px",
      hidden: visibility.isHidden("taxonomy"),
      cell: (c) => (
        <span className="text-xs text-muted-foreground">
          {c.kind === "observation" && c.taxonomyElementId
            ? TAXONOMY_ELEMENT_METADATA[c.taxonomyElementId].label
            : c.kind === "observation"
              ? "Unclassified"
              : "—"}
        </span>
      ),
    },
    {
      id: "gates",
      header: "Gates",
      width: "160px",
      hidden: visibility.isHidden("gates"),
      cell: (c) => (
        c.kind === "observation" ? (
          <Badge variant="outline" className="text-xs">Record-only</Badge>
        ) : (
          <Badge variant="secondary" className="text-xs">
            {formatGateList(c.gates)}
          </Badge>
        )
      ),
    },
    {
      id: "dependencies",
      header: "Dependencies",
      width: "200px",
      hidden: visibility.isHidden("dependencies"),
      cell: (c) => (
        <div className="flex flex-wrap gap-1">
          {(c.dependsOn ?? []).map((dep) => (
            <Badge key={dep} variant="secondary" className="text-xs font-mono">
              {dep}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "right",
      hidden: visibility.isHidden("actions"),
      cell: (c) => (
        <div className="flex items-center gap-1 justify-end">
          <Link to={`/criteria/${c.id}`} onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Eye className="h-4 w-4" />
            </Button>
          </Link>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive"
                onClick={(e) => e.stopPropagation()}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent onClick={(e) => e.stopPropagation()}>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete criterion?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete <strong>{c.id}</strong>. Criteria with dependents cannot be deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate(c.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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

  return (
    <ListLayout
      title={
        <span className="inline-flex items-center gap-1.5">
          Criteria
          <HelpTooltip
            text="Reusable evaluation rules the judge applies to agent output. Criteria can depend on each other; descendants are skipped when a parent fails."
            docs="criteria"
            size="md"
          />
        </span>
      }
      description="Manage evaluation criteria and their dependencies"
      railStorageKey="criteria"
      actions={
        <>
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={criteria.length === 0}
            onClick={() => {
              try {
                const yaml = criteriaToExportYaml(criteria);
                downloadAsFile(yaml, "criteria.yaml");
              } catch (err) {
                toast.error(`Failed to export: ${err instanceof Error ? err.message : String(err)}`);
              }
            }}
          >
            <Download className="h-4 w-4" /> Export All
          </Button>
          <Link to="/criteria/graph">
            <Button variant="outline" className="gap-1.5">
              <GitBranch className="h-4 w-4" /> Graph
            </Button>
          </Link>
          <Link to="/criteria/new">
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" /> New Criterion
            </Button>
          </Link>
        </>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search criteria..."
          footer={
            <>
              <ClearFiltersLink
                onClick={state.clearFilters}
                disabled={!state.hasActiveFilters}
              />
              <CustomizeColumnsLink onClick={() => setCustomizeOpen((v) => !v)} />
            </>
          }
        >
          <FilterSection title="Gate" storageKey="criteria-gate">
            <CheckboxFilterGroup
              options={gateFilterOptions}
              selected={state.getFilterList("gate")}
              onToggle={(value) => state.toggleFilterValue("gate", value)}
            />
          </FilterSection>
          <FilterSection title="Kind" storageKey="criteria-kind">
            <CheckboxFilterGroup
              options={kindFilterOptions}
              selected={state.getFilterList("kind")}
              onToggle={(value) => state.toggleFilterValue("kind", value)}
            />
          </FilterSection>
        </FilterRail>
      }
      secondaryPanel={
        customizeOpen ? (
          <CustomizeColumnsPanel
            columns={COLUMN_OPTIONS}
            hidden={visibility.hidden}
            onToggle={visibility.toggle}
            onSetHidden={visibility.setHidden}
            onReset={visibility.reset}
            onClose={() => setCustomizeOpen(false)}
          />
        ) : undefined
      }
      onSecondaryClose={() => setCustomizeOpen(false)}
      detail={detailOutlet}
      onDetailClose={() =>
        navigate({ pathname: "/criteria", search: window.location.search })
      }
    >
      <div className="flex flex-col gap-3">
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          itemLabel="criterion"
        >
          <Button
            variant="destructive"
            size="sm"
            className="gap-1.5"
            disabled={bulkDeleteMutation.isPending || selectedIds.size === 0}
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </BulkActionBar>

        <DataTable
          items={pageItems}
          columns={columns}
          getRowId={(c) => c.id}
          activeId={activeId}
          onRowClick={(c) =>
            navigate({ pathname: `/criteria/${c.id}/preview`, search: window.location.search })
          }
          selection={{
            selectedIds,
            onToggle: toggleRow,
            onToggleAll: toggleAll,
          }}
          sort={state.sort}
          sortDir={state.sortDir}
          onSortChange={state.toggleSort}
          loading={isLoading}
          loadingRows={state.pageSize}
          emptyState={
            state.hasActiveFilters ? "No criteria match your filters" : "No criteria defined yet"
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="criteria"
        />
      </div>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} criterion{selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected criteria. Criteria with dependents
              will be skipped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setBulkDeleteOpen(false);
                bulkDeleteMutation.mutate([...selectedIds]);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ListLayout>
  );
}

function sortKey(a: CriteriaDocument, col: string): string | number {
  switch (col) {
    case "id":
      return a.id.toLowerCase();
    default:
      return "";
  }
}
