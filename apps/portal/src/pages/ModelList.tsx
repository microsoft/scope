// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useOutlet, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { Model } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Cpu } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { AgentBadge } from "@/components/AgentBadge";
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

const FILTER_KEYS = ["provider", "agent", "status"] as const;

export function ModelList() {
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeParam } = useParams<{ id?: string }>();
  const activeId = activeParam ? decodeURIComponent(activeParam) : undefined;

  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });

  const { data: models = [], isLoading, isRefetching } = useQuery({
    queryKey: ["models"],
    queryFn: () => api.listModels(),
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

  const providerOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of models) map.set(m.provider, (map.get(m.provider) ?? 0) + 1);
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({
        value,
        label: (
          <AgentBadge
            agentId={value}
            agent={agentById.get(value)}
            triggerLink={false}
          />
        ),
        count,
      }));
  }, [models, agentById]);

  const agentOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of models) map.set(m.agentId, (map.get(m.agentId) ?? 0) + 1);
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
  }, [models]);

  const statusOptions = useMemo(() => {
    const active = models.filter((m) => !m.disappearedAt).length;
    const disappeared = models.filter((m) => m.disappearedAt).length;
    return [
      { value: "active", label: "Active", count: active },
      { value: "disappeared", label: "Disappeared", count: disappeared },
    ];
  }, [models]);

  // Default to showing only active models unless the user picks something else.
  const selectedStatuses = (() => {
    const fromUrl = state.getFilterList("status");
    return fromUrl.length > 0 ? fromUrl : ["active"];
  })();

  const filteredModels = useMemo(() => {
    const providers = state.getFilterList("provider");
    const agents = state.getFilterList("agent");
    const q = state.search.trim().toLowerCase();

    return models.filter((m) => {
      const status = m.disappearedAt ? "disappeared" : "active";
      if (!selectedStatuses.includes(status)) return false;
      if (providers.length > 0 && !providers.includes(m.provider)) return false;
      if (agents.length > 0 && !agents.includes(m.agentId)) return false;
      if (q && !m.modelId.toLowerCase().includes(q) && !m._id.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [models, selectedStatuses, state]);

  const sortedModels = useMemo(() => {
    if (!state.sort) return filteredModels;
    const sorted = [...filteredModels];
    sorted.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredModels, state.sort, state.sortDir]);

  const total = sortedModels.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedModels.slice(pageStart, pageStart + state.pageSize);

  const columns: DataTableColumn<Model>[] = [
    {
      id: "modelId",
      header: "Model ID",
      sortable: true,
      cell: (m) => (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
          {m.modelId}
        </span>
      ),
    },
    {
      id: "provider",
      header: "Provider",
      sortable: true,
      width: "140px",
      cell: (m) => <Badge variant="outline">{m.provider}</Badge>,
    },
    {
      id: "agent",
      header: "Agent",
      sortable: true,
      width: "160px",
      cell: (m) => <AgentBadge agentId={m.agentId} />,
    },
    {
      id: "status",
      header: "Status",
      width: "120px",
      cell: (m) =>
        m.disappearedAt ? (
          <Badge variant="secondary">Disappeared</Badge>
        ) : (
          <Badge variant="default">Active</Badge>
        ),
    },
    {
      id: "reasoningEffort",
      header: "Reasoning Effort",
      width: "180px",
      cell: (m) =>
        m.capabilities?.reasoningEffort?.length ? (
          <div className="flex flex-wrap gap-1">
            {m.capabilities.reasoningEffort.map((level) => (
              <Badge key={level} variant="outline" className="px-1.5 py-0 text-[10px]">
                {level}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "firstSeen",
      header: "First Seen",
      sortable: true,
      width: "160px",
      cell: (m) => (
        <span className="text-xs text-muted-foreground">{formatDate(m.firstSeenAt)}</span>
      ),
    },
    {
      id: "lastSeen",
      header: "Last Seen",
      sortable: true,
      width: "160px",
      cell: (m) => (
        <span className="text-xs text-muted-foreground">
          {m.disappearedAt ? formatDate(m.disappearedAt) : formatDate(m.lastSeenAt)}
        </span>
      ),
    },
  ];

  return (
    <ListLayout
      title="Models"
      description={`${models.length} models discovered by scanners`}
      railStorageKey="models"
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search model ID…"
          refreshing={isRefetching}
          footer={
            <ClearFiltersLink
              onClick={state.clearFilters}
              disabled={!state.hasActiveFilters && state.getFilterList("status").length === 0}
            />
          }
        >
          <FilterSection title="Status" storageKey="models-status">
            <CheckboxFilterGroup
              options={statusOptions}
              selected={selectedStatuses}
              onToggle={(v) => {
                const current = state.getFilterList("status");
                const effective = current.length > 0 ? current : ["active"];
                const next = effective.includes(v) ? effective.filter((x) => x !== v) : [...effective, v];
                state.setFilter("status", next);
              }}
            />
          </FilterSection>
          <FilterSection title="Provider" storageKey="models-provider">
            <CheckboxFilterGroup
              options={providerOptions}
              selected={state.getFilterList("provider")}
              onToggle={(v) => state.toggleFilterValue("provider", v)}
            />
          </FilterSection>
          <FilterSection title="Agent" storageKey="models-agent" defaultOpen={false}>
            <CheckboxFilterGroup
              options={agentOptions}
              selected={state.getFilterList("agent")}
              onToggle={(v) => state.toggleFilterValue("agent", v)}
            />
          </FilterSection>
        </FilterRail>
      }
      detail={detailOutlet}
      onDetailClose={() => navigate("/models")}
    >
      <div className="flex flex-col gap-3">
        <DataTable
          items={pageItems}
          columns={columns}
          getRowId={(m) => m._id}
          activeId={activeId}
          onRowClick={(m) => navigate(`/models/${encodeURIComponent(m._id)}`)}
          sort={state.sort}
          sortDir={state.sortDir}
          onSortChange={state.toggleSort}
          loading={isLoading}
          loadingRows={state.pageSize}
          emptyState={
            models.length === 0
              ? "No models found. Models are discovered automatically by model scanners."
              : "No models match the current filters."
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="models"
        />
      </div>
    </ListLayout>
  );
}

function sortKey(m: Model, col: string): string | number {
  switch (col) {
    case "modelId":
      return m.modelId.toLowerCase();
    case "provider":
      return m.provider.toLowerCase();
    case "agent":
      return m.agentId.toLowerCase();
    case "firstSeen":
      return new Date(m.firstSeenAt).getTime();
    case "lastSeen":
      return new Date(m.disappearedAt ?? m.lastSeenAt).getTime();
    default:
      return "";
  }
}
