// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useOutlet, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { ProfileWithVersion } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,
  CustomizeColumnsPanel,
  CustomizeColumnsLink,
  DataTable,
  Pagination,
  BulkActionBar,
  useHiddenColumns,
  useListUrlState,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";
import { HelpTooltip } from "@/components/HelpTooltip";
import { AgentBadge } from "@/components/AgentBadge";

const FILTER_KEYS = ["worker"] as const;

const COLUMN_DEFS: CustomizeColumnsOption[] = [
  { id: "name", label: "Name", required: true },
  { id: "version", label: "Version" },
  { id: "worker", label: "Worker" },
  { id: "model", label: "Model" },
  { id: "mcpServers", label: "MCP Servers" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
];

export function ProfileList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detailOutlet = useOutlet();
  const { profileId: activeId } = useParams<{ profileId?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const columnVisibility = useHiddenColumns({
    storageKey: "profiles",
    defaultHidden: ["mcpServers", "skills", "extensions"],
  });
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });
  const { data: agents = [] } = useQuery({
    queryKey: ["agents", "include-deleted"],
    queryFn: () => api.listAgents({ includeDeleted: true }),
    staleTime: 60_000,
  });
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent._id, agent])),
    [agents],
  );

  const deleteMutation = useMutation({
    mutationFn: (profileId: string) => api.deleteProfile(profileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      toast.success("Profile deleted");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to delete profile");
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteProfile(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(`Deleted ${deleted} profile${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const workerOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of profiles as ProfileWithVersion[]) {
      const wt = p.version?.workerType;
      if (wt) map.set(wt, (map.get(wt) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort(([a], [b]) =>
        (agentById.get(a)?.name ?? "Unknown agent").localeCompare(
          agentById.get(b)?.name ?? "Unknown agent",
        ),
      )
      .map(([workerId, count]) => ({
        value: workerId,
        label: (
          <AgentBadge
            agentId={workerId}
            agent={agentById.get(workerId)}
            triggerLink={false}
          />
        ),
        count,
      }));
  }, [profiles, agentById]);

  const filteredProfiles = useMemo(() => {
    const workers = state.getFilterList("worker");
    const q = state.search.trim().toLowerCase();
    return (profiles as ProfileWithVersion[]).filter((p) => {
      if (workers.length > 0 && (!p.version?.workerType || !workers.includes(p.version.workerType))) {
        return false;
      }
      if (q) {
        const blob = `${p.name} ${p._id}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [profiles, state]);

  const sortedProfiles = useMemo(() => {
    if (!state.sort) return filteredProfiles;
    const sorted = [...filteredProfiles];
    sorted.sort((a, b) => {
      const av = profileSortKey(a, state.sort!);
      const bv = profileSortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredProfiles, state.sort, state.sortDir]);

  const total = sortedProfiles.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedProfiles.slice(pageStart, pageStart + state.pageSize);

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

  const columns: DataTableColumn<ProfileWithVersion>[] = [
    {
      id: "name",
      header: "Name",
      sortable: true,
      cell: (p) => <span className="font-medium">{p.name}</span>,
    },
    ...(!columnVisibility.isHidden("version") ? [{
      id: "version",
      header: "Version",
      width: "90px",
      cell: (p: ProfileWithVersion) => (
        <Badge variant="secondary">v{p.version.version}</Badge>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("worker") ? [{
      id: "worker",
      header: "Worker",
      sortable: true,
      cell: (p: ProfileWithVersion) => (
        <AgentBadge
          agentId={p.version.workerType}
          version={p.version.agentVersion}
          className="text-xs"
        />
      ),
    }] : []),
    ...(!columnVisibility.isHidden("model") ? [{
      id: "model",
      header: "Model",
      width: "160px",
      cell: (p: ProfileWithVersion) => (
        <span className="font-mono text-xs">{p.version.model}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("mcpServers") ? [{
      id: "mcpServers",
      header: "MCP Servers",
      width: "110px",
      cell: (p: ProfileWithVersion) => (
        <span className="text-sm">{p.version.mcpServers?.length ?? 0}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("skills") ? [{
      id: "skills",
      header: "Skills",
      width: "80px",
      cell: (p: ProfileWithVersion) => (
        <span className="text-sm">{p.version.skillRevisions?.length ?? 0}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("extensions") ? [{
      id: "extensions",
      header: "Extensions",
      width: "100px",
      cell: (p: ProfileWithVersion) => (
        <span className="text-sm">{p.version.extensions?.length ?? 0}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("created") ? [{
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      cell: (p: ProfileWithVersion) => (
        <span className="text-xs text-muted-foreground">{formatDate(p.createdAt)}</span>
      ),
    }] : []),
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right" as const,
      cell: (p) => (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={(e) => e.stopPropagation()}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={(e) => e.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete profile?</AlertDialogTitle>
              <AlertDialogDescription>
                This will soft-delete &quot;{p.name}&quot;. Existing runs referencing this profile will not be affected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.stopPropagation();
                  deleteMutation.mutate(p._id);
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ),
    },
  ];

  return (
    <ListLayout
      title={
        <span className="inline-flex items-center gap-1.5">
          Profiles
          <HelpTooltip
            text="Saved bundles of worker, model, skills, MCP servers and extensions. Profiles make runs reproducible and easy to compare."
            docs="profiles"
            size="md"
          />
        </span>
      }
      description="Saved run configurations for reproducible benchmarking"
      railStorageKey="profiles"
      actions={
        <Button className="gap-1.5" onClick={() => navigate("/profiles/new")}>
          <Plus className="h-4 w-4" /> New Profile
        </Button>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search profiles…"
          footer={
            <div className="flex items-center justify-between gap-2">
              <ClearFiltersLink
                onClick={state.clearFilters}
                disabled={!state.hasActiveFilters}
              />
              <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
            </div>
          }
        >
          <FilterSection title="Worker" storageKey="profiles-worker">
            <CheckboxFilterGroup
              options={workerOptions}
              selected={state.getFilterList("worker")}
              onToggle={(v) => state.toggleFilterValue("worker", v)}
            />
          </FilterSection>
        </FilterRail>
      }
      secondaryPanel={
        customizeOpen ? (
          <CustomizeColumnsPanel
            columns={COLUMN_DEFS}
            hidden={columnVisibility.hidden}
            onToggle={columnVisibility.toggle}
            onSetHidden={columnVisibility.setHidden}
            onReset={columnVisibility.reset}
            onClose={() => setCustomizeOpen(false)}
          />
        ) : undefined
      }
      onSecondaryClose={() => setCustomizeOpen(false)}
      detail={detailOutlet}
      onDetailClose={() =>
        navigate({ pathname: "/profiles", search: window.location.search })
      }
    >
      <div className="flex flex-col gap-3">
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          itemLabel="profile"
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
          getRowId={(p) => p._id}
          activeId={activeId}
          onRowClick={(p) =>
            navigate({ pathname: `/profiles/${p._id}/preview`, search: window.location.search })
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
            state.hasActiveFilters
              ? "No profiles match your filters"
              : "No profiles yet. Create one to get started."
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="profiles"
        />
      </div>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} profile{selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes the selected profiles. Existing runs referencing them will not be affected.
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

function profileSortKey(p: ProfileWithVersion, col: string): string | number {
  switch (col) {
    case "name": return p.name.toLowerCase();
    case "worker": return (p.version?.workerType ?? "").toLowerCase();
    case "created": return new Date(p.createdAt).getTime();
    default: return "";
  }
}
