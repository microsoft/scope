// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Copy, MoreHorizontal, Network, Plus, Trash2 } from "lucide-react";
import { parse as parseYaml } from "yaml";
import { api } from "@/lib/api";
import type { TaxonomyListItem } from "@/types";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  useHiddenColumns,
  useListUrlState,
  type CustomizeColumnsOption,
  type DataTableColumn,
} from "@/components/list-layout";
import { toast } from "sonner";

const EMPTY_TAXONOMY = `schema_version: scope/taxonomy/v1
id: my-taxonomy
version: 1.0.0
surfaces: []
elements:
  - ref: beh-discovered@r1
`;

const FILTER_KEYS = ["sourceType"] as const;

const COLUMN_DEFS: CustomizeColumnsOption[] = [
  { id: "name", label: "Name", required: true },
  { id: "ref", label: "ID / exact ref" },
  { id: "version", label: "Semantic version" },
  { id: "sourceType", label: "Source" },
  { id: "revision", label: "Scope revision" },
  { id: "elements", label: "Elements" },
  { id: "updated", label: "Updated" },
  { id: "actions", label: "Actions" },
];

/** Project taxonomy management using the shared list/table interaction model. */
export function TaxonomyList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const state = useListUrlState({
    defaultPageSize: 25,
    filterKeys: FILTER_KEYS,
  });
  const columnVisibility = useHiddenColumns({ storageKey: "taxonomies" });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaxonomyListItem>();
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState(EMPTY_TAXONOMY);

  const { data: taxonomies = [], isLoading, error } = useQuery({
    queryKey: ["taxonomies"],
    queryFn: api.listTaxonomies,
  });

  const create = useMutation({
    mutationFn: () =>
      api.createTaxonomy({ name, content: parseYaml(yaml) as unknown }),
    onSuccess: (created) => {
      setCreateOpen(false);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      toast.success("Taxonomy created");
      navigate(`/taxonomies/${created._id}`);
    },
    onError: (mutationError) =>
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : "Creation failed",
      ),
  });
  const remove = useMutation({
    mutationFn: api.deleteTaxonomy,
    onSuccess: () => {
      setDeleteTarget(undefined);
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      toast.success("Taxonomy deleted");
    },
    onError: (mutationError) =>
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : "Deletion failed",
      ),
  });
  const copy = useMutation({
    mutationFn: async (taxonomy: TaxonomyListItem) => {
      if (!taxonomy.latestRevisionId) {
        throw new Error("Built-in taxonomy has no revision");
      }
      return api.copyTaxonomyRevision(taxonomy.latestRevisionId, {
        name: `${taxonomy.name} copy`,
        id: `${taxonomy.id}-copy`,
      });
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      toast.success("Built-in taxonomy copied");
      navigate(`/taxonomies/${created._id}`);
    },
    onError: (mutationError) =>
      toast.error(
        mutationError instanceof Error ? mutationError.message : "Copy failed",
      ),
  });

  const sourceOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const taxonomy of taxonomies) {
      counts.set(
        taxonomy.sourceType,
        (counts.get(taxonomy.sourceType) ?? 0) + 1,
      );
    }
    return [...counts.entries()].map(([value, count]) => ({
      value,
      label: value === "builtin" ? "Built-in" : "User",
      count,
    }));
  }, [taxonomies]);

  const filtered = useMemo(() => {
    const sourceTypes = state.getFilterList("sourceType");
    const search = state.search.trim().toLowerCase();
    return taxonomies.filter(taxonomy => {
      if (
        sourceTypes.length > 0 &&
        !sourceTypes.includes(taxonomy.sourceType)
      ) {
        return false;
      }
      if (!search) return true;
      return [
        taxonomy.name,
        taxonomy.id,
        taxonomy.ref,
        taxonomy.version,
        taxonomy.description ?? "",
      ].some(value => value.toLowerCase().includes(search));
    });
  }, [state, taxonomies]);

  const sorted = useMemo(() => {
    const items = [...filtered];
    if (!state.sort) return items;
    items.sort((left, right) => {
      const leftValue = taxonomySortValue(left, state.sort!);
      const rightValue = taxonomySortValue(right, state.sort!);
      return leftValue.localeCompare(rightValue, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
    if (state.sortDir === "desc") items.reverse();
    return items;
  }, [filtered, state.sort, state.sortDir]);

  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sorted.slice(pageStart, pageStart + state.pageSize);

  const columns: DataTableColumn<TaxonomyListItem>[] = [
    {
      id: "name",
      header: "Name",
      sortable: true,
      cell: taxonomy => (
        <button
          type="button"
          className="text-left font-medium text-primary hover:underline"
          onClick={event => {
            event.stopPropagation();
            navigate(`/taxonomies/${taxonomy._id}`);
          }}
        >
          {taxonomy.name}
        </button>
      ),
    },
    ...(!columnVisibility.isHidden("ref") ? [{
      id: "ref",
      header: "ID / exact ref",
      sortable: true,
      cell: (taxonomy: TaxonomyListItem) => (
        <span className="font-mono text-xs">{taxonomy.ref}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("version") ? [{
      id: "version",
      header: "Version",
      sortable: true,
      width: "120px",
      cell: (taxonomy: TaxonomyListItem) => (
        <span className="font-mono text-xs">{taxonomy.version}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("sourceType") ? [{
      id: "sourceType",
      header: "Source",
      width: "150px",
      cell: (taxonomy: TaxonomyListItem) => (
        <Badge
          variant={taxonomy.sourceType === "builtin" ? "secondary" : "outline"}
        >
          {taxonomy.sourceType === "builtin" ? "Built-in · read-only" : "User"}
        </Badge>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("revision") ? [{
      id: "revision",
      header: "Scope revision",
      sortable: true,
      width: "120px",
      cell: (taxonomy: TaxonomyListItem) => (
        <span className="font-mono text-xs">r{taxonomy.latestRevision}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("elements") ? [{
      id: "elements",
      header: "Elements",
      sortable: true,
      width: "100px",
      align: "right" as const,
      cell: (taxonomy: TaxonomyListItem) => taxonomy.elementCount,
    }] : []),
    ...(!columnVisibility.isHidden("updated") ? [{
      id: "updated",
      header: "Updated",
      sortable: true,
      width: "160px",
      cell: (taxonomy: TaxonomyListItem) => (
        <span className="text-xs text-muted-foreground">
          {formatDate(taxonomy.updatedAt ?? taxonomy.createdAt)}
        </span>
      ),
    }] : []),
    {
      id: "actions",
      header: "",
      width: "56px",
      align: "right",
      cell: taxonomy => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`Actions for ${taxonomy.name}`}
              onClick={event => event.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={event => event.stopPropagation()}>
            <DropdownMenuItem onClick={() => navigate(`/taxonomies/${taxonomy._id}`)}>
              <Network className="mr-2 h-4 w-4" /> View details
            </DropdownMenuItem>
            {taxonomy.sourceType === "builtin" ? (
              <DropdownMenuItem onClick={() => copy.mutate(taxonomy)}>
                <Copy className="mr-2 h-4 w-4" /> Copy to user taxonomy
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setDeleteTarget(taxonomy)}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <ListLayout
        title="Taxonomies"
        description="Manage project-scoped taxonomy roots and inspect exact immutable revisions"
        railStorageKey="taxonomies"
        actions={(
          <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New taxonomy
          </Button>
        )}
        filterRail={(
          <FilterRail
            search={state.search}
            onSearchChange={state.setSearch}
            searchPlaceholder="Search taxonomies…"
            footer={(
              <div className="flex items-center justify-between gap-2">
                <ClearFiltersLink
                  onClick={state.clearFilters}
                  disabled={!state.hasActiveFilters}
                />
                <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
              </div>
            )}
          >
            <FilterSection title="Source" storageKey="taxonomies-source">
              <CheckboxFilterGroup
                options={sourceOptions}
                selected={state.getFilterList("sourceType")}
                onToggle={value =>
                  state.toggleFilterValue("sourceType", value)
                }
              />
            </FilterSection>
          </FilterRail>
        )}
        secondaryPanel={customizeOpen ? (
          <CustomizeColumnsPanel
            columns={COLUMN_DEFS}
            hidden={columnVisibility.hidden}
            onToggle={columnVisibility.toggle}
            onSetHidden={columnVisibility.setHidden}
            onReset={columnVisibility.reset}
            onClose={() => setCustomizeOpen(false)}
          />
        ) : undefined}
        onSecondaryClose={() => setCustomizeOpen(false)}
      >
        <div className="flex flex-col gap-3">
          <DataTable
            items={pageItems}
            columns={columns}
            getRowId={taxonomy => taxonomy._id}
            onRowClick={taxonomy => navigate(`/taxonomies/${taxonomy._id}`)}
            sort={state.sort}
            sortDir={state.sortDir}
            onSortChange={state.toggleSort}
            loading={isLoading}
            loadingRows={state.pageSize}
            emptyState={
              error
                ? "Taxonomies could not be loaded."
                : state.hasActiveFilters
                  ? "No taxonomies match your filters."
                  : "No taxonomies yet. Create one or copy the built-in catalog."
            }
          />
          <Pagination
            page={state.page}
            pageSize={state.pageSize}
            total={sorted.length}
            onPageChange={state.setPage}
            onPageSizeChange={state.setPageSize}
            itemLabel="taxonomies"
          />
        </div>
      </ListLayout>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="grid max-h-[85vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)]">
          <DialogHeader><DialogTitle>Create taxonomy</DialogTitle></DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
            <div className="space-y-2">
              <Label htmlFor="taxonomy-name">Name</Label>
              <Input
                id="taxonomy-name"
                value={name}
                onChange={event => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="taxonomy-yaml">Portable YAML</Label>
              <Textarea
                id="taxonomy-yaml"
                className="min-h-80 font-mono text-xs"
                value={yaml}
                onChange={event => setYaml(event.target.value)}
              />
            </div>
            <div className="sticky bottom-0 flex justify-end border-t bg-background py-3">
              <Button
                disabled={!name.trim() || create.isPending}
                onClick={() => create.mutate()}
              >
                Create revision 1
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={open => !open && setDeleteTarget(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete taxonomy?</AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes &quot;{deleteTarget?.name}&quot;. Existing
              Experiment revisions retain their exact pinned taxonomy revision.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={() => deleteTarget && remove.mutate(deleteTarget._id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function taxonomySortValue(
  taxonomy: TaxonomyListItem,
  field: string,
): string {
  switch (field) {
    case "name":
      return taxonomy.name;
    case "ref":
      return taxonomy.ref;
    case "version":
      return taxonomy.version;
    case "revision":
      return String(taxonomy.latestRevision ?? 0).padStart(10, "0");
    case "elements":
      return String(taxonomy.elementCount).padStart(10, "0");
    case "updated":
      return taxonomy.updatedAt ?? taxonomy.createdAt;
    default:
      return taxonomy.name;
  }
}
