// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback, useMemo, useState, type Key } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Boxes, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ResourceDocument, ResourceRevisionDocument } from "@/types";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { HelpTooltip } from "@/components/HelpTooltip";
import {
  BulkActionBar,
  ClearFiltersLink,
  CustomizeColumnsLink,
  CustomizeColumnsPanel,
  DataTable,
  FilterRail,
  ListLayout,
  Pagination,
  useHiddenColumns,
  useListUrlState,
  type CustomizeColumnsOption,
  type DataTableColumn,
} from "@/components/list-layout";
import { ResourcePreviewPanel } from "./ResourcePreviewPanel";

const COLUMN_DEFS: CustomizeColumnsOption[] = [
  { id: "slug", label: "Slug", required: true },
  { id: "name", label: "Name" },
  { id: "latest", label: "Latest revision" },
  { id: "exports", label: "Exports" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
];

export function ResourceList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const previewId = searchParams.get("preview");
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: [] });
  const columnVisibility = useHiddenColumns({ storageKey: "resources" });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: resources = [], isLoading } = useQuery({ queryKey: ["resources"], queryFn: () => api.listResources() });

  const deleteMutation = useMutation({
    mutationFn: api.deleteResource,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      toast.success("Resource deleted");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete resource"),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteResource(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(`Deleted ${deleted} resource${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const activeResources = useMemo(() => resources.filter((resource: ResourceDocument) => !resource.deletedAt), [resources]);

  const filteredResources = useMemo(() => {
    const q = state.search.trim().toLowerCase();
    if (!q) return activeResources;
    return activeResources.filter((resource) => {
      const blob = `${resource._id} ${resource.slug} ${resource.name} ${resource.description ?? ""}`.toLowerCase();
      return blob.includes(q);
    });
  }, [activeResources, state.search]);

  const sortedResources = useMemo(() => {
    if (!state.sort) return filteredResources;
    const sorted = [...filteredResources];
    sorted.sort((a, b) => {
      const av = resourceSortKey(a, state.sort!);
      const bv = resourceSortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredResources, state.sort, state.sortDir]);

  const total = sortedResources.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedResources.slice(pageStart, pageStart + state.pageSize);

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

  const navigateToPreview = useCallback((id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("preview", id);
    navigate({ pathname: "/resources", search: `?${params.toString()}` });
  }, [navigate]);

  const closePreview = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("preview");
    const search = params.toString();
    navigate({ pathname: "/resources", search: search ? `?${search}` : "" });
  }, [navigate]);

  const columns: DataTableColumn<ResourceDocument>[] = [
    {
      id: "slug",
      header: "Slug",
      sortable: true,
      width: "220px",
      cell: (resource) => (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          {resource.slug}
        </span>
      ),
    },
    ...(!columnVisibility.isHidden("name") ? [{ id: "name", header: "Name", sortable: true, cell: (resource: ResourceDocument) => <span className="text-sm">{resource.name}</span> }] : []),
    ...(!columnVisibility.isHidden("latest") ? [{ id: "latest", header: "Latest revision", width: "150px", cell: (resource: ResourceDocument) => <LatestRevisionRef resource={resource} /> }] : []),
    ...(!columnVisibility.isHidden("exports") ? [{ id: "exports", header: "Exports", width: "110px", cell: (resource: ResourceDocument) => <LatestExportCount resource={resource} /> }] : []),
    ...(!columnVisibility.isHidden("created") ? [{ id: "created", header: "Created", sortable: true, width: "160px", cell: (resource: ResourceDocument) => <span className="text-xs text-muted-foreground">{formatDate(resource.createdAt)}</span> }] : []),
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right" as const,
      cell: (resource) => (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={(ev) => ev.stopPropagation()}><Trash2 className="h-4 w-4" /></Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={(ev) => ev.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete resource?</AlertDialogTitle>
              <AlertDialogDescription>This soft-deletes the resource &quot;{resource.name}&quot;. Existing runs keep their resolved revision.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate(resource._id)}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ),
    },
  ];

  return (
    <ListLayout
      title={<span className="inline-flex items-center gap-1.5">Resources<HelpTooltip text="Lifecycle definitions that provision dependencies for runs. Each edit creates an immutable revision." size="md" /></span>}
      description="Manage setup and teardown lifecycle definitions used by benchmark runs"
      railStorageKey="resources"
      actions={<Button className="gap-1.5" onClick={() => navigate("/resources/new")}><Plus className="h-4 w-4" /> Create Resource</Button>}
      filterRail={(
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search resources…"
          footer={<div className="flex items-center justify-between gap-2"><ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} /><CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} /></div>}
        >
          <></>
        </FilterRail>
      )}
      secondaryPanel={customizeOpen ? <CustomizeColumnsPanel columns={COLUMN_DEFS} hidden={columnVisibility.hidden} onToggle={columnVisibility.toggle} onSetHidden={columnVisibility.setHidden} onReset={columnVisibility.reset} onClose={() => setCustomizeOpen(false)} /> : undefined}
      onSecondaryClose={() => setCustomizeOpen(false)}
      detail={previewId ? <ResourcePreviewPanel id={previewId} /> : undefined}
      onDetailClose={closePreview}
    >
      <div className="flex flex-col gap-3">
        <BulkActionBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())} itemLabel="resource">
          <Button variant="destructive" size="sm" className="gap-1.5" disabled={bulkDeleteMutation.isPending || selectedIds.size === 0} onClick={() => setBulkDeleteOpen(true)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
        </BulkActionBar>
        <DataTable
          items={pageItems}
          columns={columns}
          getRowId={(resource) => resource._id}
          activeId={previewId ?? undefined}
          onRowClick={(resource) => navigateToPreview(resource.slug)}
          selection={{ selectedIds, onToggle: toggleRow, onToggleAll: toggleAll }}
          sort={state.sort}
          sortDir={state.sortDir}
          onSortChange={state.toggleSort}
          loading={isLoading}
          loadingRows={state.pageSize}
          emptyState={state.hasActiveFilters ? "No resources match your filters" : "No resources yet. Create one to provision dependencies for runs."}
        />
        <Pagination page={state.page} pageSize={state.pageSize} total={total} onPageChange={state.setPage} onPageSizeChange={state.setPageSize} itemLabel="resources" />
      </div>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} resource{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>This soft-deletes the selected resources. Existing runs keep their resolved revisions.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { setBulkDeleteOpen(false); bulkDeleteMutation.mutate([...selectedIds]); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ListLayout>
  );
}

function LatestRevisionRef({ resource }: { resource: ResourceDocument }) {
  const { data: revision, isLoading } = useLatestRevision(resource);
  if (isLoading) return <Skeleton className="h-4 w-24" />;
  const fallback = resource.latestRevisionNumber ?? resource.revisionCounter;
  return <span className="font-mono text-xs text-muted-foreground">{revision?.ref ?? (fallback > 0 ? `${resource.slug}@r${fallback}` : "—")}</span>;
}

function LatestExportCount({ resource }: { resource: ResourceDocument }) {
  const { data: revision, isLoading } = useLatestRevision(resource);
  if (isLoading) return <Skeleton className="h-4 w-10" />;
  return <span className="text-sm">{revision?.exports.length ?? "—"}</span>;
}

function useLatestRevision(resource: ResourceDocument) {
  return useQuery<ResourceRevisionDocument | null>({
    queryKey: ["resource-revision", resource.latestRevisionId],
    queryFn: async () => resource.latestRevisionId ? api.getResourceRevision(resource.latestRevisionId) : null,
    enabled: !!resource.latestRevisionId,
  });
}

function resourceSortKey(resource: ResourceDocument, col: string): string | number {
  switch (col) {
    case "slug": return resource.slug;
    case "name": return resource.name.toLowerCase();
    case "created": return new Date(resource.createdAt).getTime();
    default: return "";
  }
}
