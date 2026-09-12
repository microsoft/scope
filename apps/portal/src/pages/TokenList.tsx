// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation, useOutlet, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { KeyDocument, KeyCapability } from "@/types";
import { KEY_TYPE_LABELS, KEY_CAPABILITY_LABELS, ALL_CAPABILITIES } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, ShieldCheck, KeyRound, AlertTriangle } from "lucide-react";
import { formatDate, formatId } from "@/lib/utils";
import { toast } from "sonner";
import { Link } from "react-router-dom";
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
  useListUrlState,
  useHiddenColumns,
  type DataTableColumn,
} from "@/components/list-layout";

const FILTER_KEYS = ["capability"] as const;

const COLUMN_OPTIONS = [
  { id: "id", label: "ID", required: true },
  { id: "comment", label: "Comment" },
  { id: "type", label: "Type" },
  { id: "capabilities", label: "Capabilities" },
  { id: "status", label: "Status" },
  { id: "enabled", label: "Enabled" },
  { id: "lastValidated", label: "Last Validated" },
  { id: "created", label: "Created" },
  { id: "acquired", label: "Acquired" },
  { id: "actions", label: "Actions" },
] as const;

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "valid": return "default";
    case "invalid":
    case "expired": return "destructive";
    case "error": return "secondary";
    default: return "outline";
  }
}

function SecretsTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname.startsWith("/secrets/accounts") ? "accounts" : "keys";
  return (
    <div className="border-b border-border/60 px-6 pt-3">
      <Tabs value={current} onValueChange={(v) => navigate(v === "accounts" ? "/secrets/accounts" : "/secrets/keys")}>
        <TabsList>
          <TabsTrigger value="keys">Keys</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

export function TokenList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const columnVisibility = useHiddenColumns({ storageKey: "tokens" });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: tokens = [], isLoading, isRefetching } = useQuery({
    queryKey: ["tokens"],
    queryFn: () => api.listKeys(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      toast.success("Key deleted");
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteKey(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(`Deleted ${deleted} key${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const validateMutation = useMutation({
    mutationFn: api.validateKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      toast.success("Key validated");
    },
  });

  const activeTokens = useMemo(() => tokens.filter((t: KeyDocument) => !t.deletedAt), [tokens]);

  const coveredCapabilities = useMemo(() => {
    const covered = new Set<KeyCapability>();
    for (const t of activeTokens) {
      if (t.enabled && t.lastValidationStatus === "valid") {
        for (const c of t.capabilities ?? []) covered.add(c);
      }
    }
    return covered;
  }, [activeTokens]);

  const uncoveredCapabilities = useMemo(
    () => ALL_CAPABILITIES.filter((c) => !coveredCapabilities.has(c)),
    [coveredCapabilities],
  );

  const capabilityOptions = useMemo(() => {
    return ALL_CAPABILITIES.map((c) => ({
      value: c,
      label: KEY_CAPABILITY_LABELS[c],
      count: activeTokens.filter((t) => (t.capabilities ?? []).includes(c)).length,
    }));
  }, [activeTokens]);

  const selectedCapabilities = state.getFilterList("capability");

  const filteredTokens = useMemo(() => {
    const q = state.search.trim().toLowerCase();
    return activeTokens.filter((t) => {
      if (selectedCapabilities.length > 0) {
        const hasCap = selectedCapabilities.some((c) => (t.capabilities ?? []).includes(c as KeyCapability));
        if (!hasCap) return false;
      }
      if (q) {
        const blob = `${t._id} ${t.comment ?? ""} ${t.type} ${(t.capabilities ?? []).join(" ")}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [activeTokens, selectedCapabilities, state.search]);

  const sortedTokens = useMemo(() => {
    if (!state.sort) return filteredTokens;
    const sorted = [...filteredTokens];
    sorted.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredTokens, state.sort, state.sortDir]);

  const total = sortedTokens.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedTokens.slice(pageStart, pageStart + state.pageSize);

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

  const columns: DataTableColumn<KeyDocument>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "130px",
      hidden: columnVisibility.isHidden("id"),
      cell: (t) => (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          {formatId(t._id)}
        </span>
      ),
    },
    {
      id: "comment",
      header: "Comment",
      hidden: columnVisibility.isHidden("comment"),
      cell: (t) => (
        <span className="text-sm max-w-[200px] truncate block" title={t.comment ?? undefined}>
          {t.comment || <span className="text-muted-foreground">—</span>}
        </span>
      ),
    },
    {
      id: "type",
      header: "Type",
      sortable: true,
      width: "180px",
      hidden: columnVisibility.isHidden("type"),
      cell: (t) => (
        <Badge variant="outline" className="gap-1 text-xs">
          {KEY_TYPE_LABELS[t.type]}
        </Badge>
      ),
    },
    {
      id: "capabilities",
      header: "Capabilities",
      hidden: columnVisibility.isHidden("capabilities"),
      cell: (t) => (
        <div className="flex flex-wrap gap-1">
          {(t.capabilities ?? []).length > 0
            ? t.capabilities.map((c) => (
                <Badge key={c} variant="secondary" className="text-xs">
                  {KEY_CAPABILITY_LABELS[c]}
                </Badge>
              ))
            : <span className="text-xs text-muted-foreground">—</span>
          }
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "100px",
      hidden: columnVisibility.isHidden("status"),
      cell: (t) => (
        <Badge variant={statusVariant(t.lastValidationStatus)} className="text-xs">
          {t.lastValidationStatus}
        </Badge>
      ),
    },
    {
      id: "enabled",
      header: "Enabled",
      width: "80px",
      hidden: columnVisibility.isHidden("enabled"),
      cell: (t) => (
        <Badge variant={t.enabled ? "default" : "secondary"} className="text-xs">
          {t.enabled ? "Yes" : "No"}
        </Badge>
      ),
    },
    {
      id: "lastValidated",
      header: "Last Validated",
      sortable: true,
      width: "150px",
      hidden: columnVisibility.isHidden("lastValidated"),
      cell: (t) => (
        <span className="text-xs text-muted-foreground">
          {t.lastValidatedAt ? formatDate(t.lastValidatedAt) : "—"}
        </span>
      ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      width: "140px",
      hidden: columnVisibility.isHidden("created"),
      cell: (t) => (
        <span className="text-xs text-muted-foreground">{formatDate(t.createdAt)}</span>
      ),
    },
    {
      id: "acquired",
      header: "Acquired",
      sortable: true,
      width: "100px",
      hidden: columnVisibility.isHidden("acquired"),
      cell: (t) => (
        <span className="text-xs text-muted-foreground">{(t.acquireCount ?? 0).toLocaleString()}×</span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "right",
      hidden: columnVisibility.isHidden("actions"),
      cell: (t) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={validateMutation.isPending}
            onClick={(e) => { e.stopPropagation(); validateMutation.mutate(t._id); }}
            title="Validate key"
          >
            <ShieldCheck className="h-4 w-4" />
          </Button>
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
                <AlertDialogTitle>Delete key?</AlertDialogTitle>
                <AlertDialogDescription>
                  This soft-deletes the key. The KeyVault secret is preserved.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteMutation.mutate(t._id)}>
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
    <div className="flex h-full min-h-0 flex-col">
      <SecretsTabs />
      <div className="min-h-0 flex-1">
        <ListLayout
          title="Keys"
          description="Manage API keys for workers and services"
          railStorageKey="tokens"
          actions={
            <Link to="/secrets/keys/new">
              <Button size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" /> Register Key
              </Button>
            </Link>
          }
          filterRail={
            <FilterRail
              search={state.search}
              onSearchChange={state.setSearch}
              searchPlaceholder="Search keys…"
              refreshing={isRefetching}
              footer={
                <>
                  <ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} />
                  <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
                </>
              }
            >
              <FilterSection title="Capability" storageKey="tokens-capability">
                <CheckboxFilterGroup
                  options={capabilityOptions}
                  selected={selectedCapabilities}
                  onToggle={(v) => state.toggleFilterValue("capability", v)}
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
                onReset={columnVisibility.reset}
                onClose={() => setCustomizeOpen(false)}
              />
            ) : null
          }
          onSecondaryClose={() => setCustomizeOpen(false)}
          detail={detailOutlet}
          onDetailClose={() =>
            navigate({ pathname: "/secrets/keys", search: window.location.search })
          }
        >
          <div className="flex flex-col gap-3">
            {!isLoading && uncoveredCapabilities.length > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  <span className="font-medium">Missing coverage:</span>{" "}
                  {uncoveredCapabilities.map((c) => KEY_CAPABILITY_LABELS[c]).join(", ")}.
                  Register a key with these capabilities to enable the corresponding features.
                </span>
              </div>
            )}
            <BulkActionBar
              count={selectedIds.size}
              onClear={() => setSelectedIds(new Set())}
              itemLabel="key"
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
              getRowId={(t) => t._id}
              activeId={activeId}
              onRowClick={(t) =>
                navigate({ pathname: `/secrets/keys/${t._id}/preview`, search: window.location.search })
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
                  ? "No keys match your filters"
                  : "No keys registered yet"
              }
            />
            <Pagination
              page={state.page}
              pageSize={state.pageSize}
              total={total}
              onPageChange={state.setPage}
              onPageSizeChange={state.setPageSize}
              itemLabel="keys"
            />
          </div>

          <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Delete {selectedIds.size} key{selectedIds.size !== 1 ? "s" : ""}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This soft-deletes the selected keys. The KeyVault secrets are preserved.
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
      </div>
    </div>
  );
}

function sortKey(t: KeyDocument, col: string): string | number {
  switch (col) {
    case "id": return t._id;
    case "type": return t.type.toLowerCase();
    case "lastValidated": return t.lastValidatedAt ? new Date(t.lastValidatedAt).getTime() : 0;
    case "created": return new Date(t.createdAt).getTime();
    case "acquired": return t.acquireCount ?? 0;
    default: return "";
  }
}
