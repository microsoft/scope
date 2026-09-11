// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useOutlet, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { CodingAgent } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Trash2, Bot } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { ServerAgentSetup } from "@/components/ServerAgentSetup";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,
  DataTable,
  Pagination,
  useListUrlState,
  type DataTableColumn,
} from "@/components/list-layout";

const FILTER_KEYS = ["availability", "provider"] as const;

export function AgentList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });

  const { data: agents = [], isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.listAgents(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Agent deleted");
    },
  });

  const activeAgents = useMemo(
    () => agents.filter((a) => !a.deletedAt),
    [agents],
  );

  const availabilityOptions = useMemo(() => {
    const available = activeAgents.filter((a) => a.available !== false).length;
    const unavailable = activeAgents.filter((a) => a.available === false).length;
    return [
      { value: "available", label: "Available", count: available },
      { value: "unavailable", label: "Unavailable", count: unavailable },
    ];
  }, [activeAgents]);

  const providerOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of activeAgents) {
      if (a.modelProvider) map.set(a.modelProvider, (map.get(a.modelProvider) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
  }, [activeAgents]);

  const filteredAgents = useMemo(() => {
    const availability = state.getFilterList("availability");
    const providers = state.getFilterList("provider");
    const q = state.search.trim().toLowerCase();

    return activeAgents.filter((a) => {
      if (availability.length > 0) {
        const status = a.available === false ? "unavailable" : "available";
        if (!availability.includes(status)) return false;
      }
      if (providers.length > 0 && (!a.modelProvider || !providers.includes(a.modelProvider))) {
        return false;
      }
      if (q) {
        const blob = `${a._id} ${a.name} ${a.modelProvider ?? ""} ${a.defaultModel ?? ""}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [activeAgents, state]);

  const sortedAgents = useMemo(() => {
    if (!state.sort) return filteredAgents;
    const sorted = [...filteredAgents];
    sorted.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredAgents, state.sort, state.sortDir]);

  const total = sortedAgents.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedAgents.slice(pageStart, pageStart + state.pageSize);

  const columns: DataTableColumn<CodingAgent>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "120px",
      cell: (a) => (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          {a._id}
        </span>
      ),
    },
    {
      id: "name",
      header: "Name",
      sortable: true,
      cell: (a) => <span className="text-sm">{a.name}</span>,
    },
    {
      id: "availability",
      header: "Availability",
      width: "120px",
      cell: (a) =>
        a.available === false ? (
          <Badge variant="secondary" className="text-xs">Unavailable</Badge>
        ) : (
          <Badge variant="default" className="text-xs">Available</Badge>
        ),
    },
    {
      id: "provider",
      header: "Provider",
      sortable: true,
      width: "140px",
      cell: (a) =>
        a.modelProvider ? (
          <Badge variant="outline" className="text-xs font-mono">{a.modelProvider}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "defaultModel",
      header: "Default Model",
      width: "180px",
      cell: (a) =>
        a.defaultModel ? (
          <Badge variant="outline">{a.defaultModel}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      cell: (a) => (
        <span className="text-xs text-muted-foreground">{formatDate(a.createdAt)}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right",
      cell: (a) => (
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
              <AlertDialogTitle>Delete agent?</AlertDialogTitle>
              <AlertDialogDescription>
                This soft-deletes <strong>{a.name}</strong>. It can be re-seeded on next deployment.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate(a._id)}>
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
      title="Agents"
      description="Coding agents and their supported models"
      actions={<ServerAgentSetup />}
      railStorageKey="agents"
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search agents…"
          footer={
            <ClearFiltersLink
              onClick={state.clearFilters}
              disabled={!state.hasActiveFilters}
            />
          }
        >
          <FilterSection title="Availability" storageKey="agents-availability">
            <CheckboxFilterGroup
              options={availabilityOptions}
              selected={state.getFilterList("availability")}
              onToggle={(v) => state.toggleFilterValue("availability", v)}
            />
          </FilterSection>
          <FilterSection title="Model Provider" storageKey="agents-provider">
            <CheckboxFilterGroup
              options={providerOptions}
              selected={state.getFilterList("provider")}
              onToggle={(v) => state.toggleFilterValue("provider", v)}
            />
          </FilterSection>
        </FilterRail>
      }
      detail={detailOutlet}
      onDetailClose={() => navigate("/agents")}
    >
      <div className="flex flex-col gap-3">
        <DataTable
          items={pageItems}
          columns={columns}
          getRowId={(a) => a._id}
          activeId={activeId}
          onRowClick={(a) => navigate(`/agents/${a._id}`)}
          sort={state.sort}
          sortDir={state.sortDir}
          onSortChange={state.toggleSort}
          loading={isLoading}
          loadingRows={state.pageSize}
          emptyState={
            state.hasActiveFilters
              ? "No agents match your filters"
              : "No agents registered yet. Agents are seeded automatically on deployment."
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="agents"
        />
      </div>
    </ListLayout>
  );
}

function sortKey(a: CodingAgent, col: string): string | number {
  switch (col) {
    case "id":
      return a._id;
    case "name":
      return a.name.toLowerCase();
    case "provider":
      return (a.modelProvider ?? "").toLowerCase();
    case "created":
      return new Date(a.createdAt).getTime();
    default:
      return "";
  }
}
