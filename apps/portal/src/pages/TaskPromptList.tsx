// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useOutlet, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { TaskPrompt, PromptType } from "@/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Trash2, Eye, Plus, List, ArrowRight, ArrowLeft, Info, Loader2, MessageSquareText } from "lucide-react";
import { formatDate, formatId, truncate } from "@/lib/utils";
import { TaskPromptFeatures } from "@/components/TaskPromptFeatures";
import { TaskPromptBadge } from "@/components/TaskPromptBadge";
import { TaskPromptPicker } from "@/components/TaskPromptPicker";
import { Stepper } from "@/components/Stepper";
import { GATE_METADATA, promptTypeLabel } from "@/lib/gates";
import { useVisibleGates } from "@/hooks/useVisibleGates";
import { KbdBadge } from "@/components/KbdBadge";
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

const DIALOG_STEPS = ["Task Text", "Features"];
const FILTER_KEYS = ["type"] as const;

const COLUMN_OPTIONS: CustomizeColumnsOption[] = [
  { id: "id", label: "ID", required: true },
  { id: "text", label: "Text" },
  { id: "type", label: "Type" },
  { id: "features", label: "Features" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
];

export function TaskPromptList() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogStep, setDialogStep] = useState<1 | 2>(1);
  const [newText, setNewText] = useState("");
  const [newType, setNewType] = useState<PromptType>("select");
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const visibleGates = useVisibleGates();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const visibility = useHiddenColumns({ storageKey: "task-prompts" });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const selectedTypes = state.getFilterList("type") as PromptType[];
  const typeFilter = selectedTypes.length === 1 ? selectedTypes[0] : undefined;

  const { data, isLoading } = useQuery({
    queryKey: ["task-prompts", state.search, typeFilter],
    queryFn: () => api.listTaskPrompts({ search: state.search || undefined, type: typeFilter }),
  });

  const items = data?.items ?? [];

  const deleteMutation = useMutation({
    mutationFn: api.deleteTaskPrompt,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task-prompts"] }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteTaskPrompt(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(`Deleted ${deleted} task prompt${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["task-prompts"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const createMutation = useMutation({
    mutationFn: ({ text, type }: { text: string; type: PromptType }) => api.createTaskPrompt(text, type),
    onSuccess: (prompt) => {
      queryClient.invalidateQueries({ queryKey: ["task-prompts"] });
      resetDialog();
      navigate(`/task-prompts/${prompt._id}`);
    },
  });

  const resetDialog = () => {
    setDialogOpen(false);
    setDialogStep(1);
    setNewText("");
    setNewType("select");
    createMutation.reset();
  };

  const sortedItems = useMemo(() => {
    if (!state.sort) return items;
    const sorted = [...items];
    sorted.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [items, state.sort, state.sortDir]);

  const total = sortedItems.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedItems.slice(pageStart, pageStart + state.pageSize);

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

  const columns: DataTableColumn<TaskPrompt>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "140px",
      hidden: visibility.isHidden("id"),
      cell: (tp) => (
        <TaskPromptBadge taskPromptId={tp._id} prompt={tp}>
          <span className="flex items-center gap-1.5 font-mono text-xs">
            <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />
            {formatId(tp._id)}
          </span>
        </TaskPromptBadge>
      ),
    },
    {
      id: "text",
      header: "Text",
      hidden: visibility.isHidden("text"),
      cell: (tp) => (
        <span className="text-sm text-muted-foreground">{truncate(tp.text ?? "", 80)}</span>
      ),
    },
    {
      id: "type",
      header: "Type",
      width: "110px",
      hidden: visibility.isHidden("type"),
      cell: (tp) => (
        <Badge variant="secondary" className="text-xs">
          {promptTypeLabel(tp.type)}
        </Badge>
      ),
    },
    {
      id: "features",
      header: "Features",
      width: "100px",
      hidden: visibility.isHidden("features"),
      cell: (tp) =>
        tp.features ? (
          <Badge variant="secondary" className="text-xs">
            {tp.features.filter((f) => f.detected).length}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      hidden: visibility.isHidden("created"),
      cell: (tp) => (
        <span className="text-xs text-muted-foreground">{formatDate(tp.createdAt)}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "100px",
      align: "right",
      hidden: visibility.isHidden("actions"),
      cell: (tp) => (
        <div className="flex items-center gap-1 justify-end">
          <Link to={`/task-prompts/${tp._id}`} onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Eye className="h-4 w-4" />
            </Button>
          </Link>
          <Link to={`/runs?taskPromptId=${encodeURIComponent(tp._id)}`} onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="View runs for this task prompt">
              <List className="h-4 w-4" />
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
                <AlertDialogTitle>Delete task prompt?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will soft-delete task prompt{" "}
                  <code className="font-mono">{formatId(tp._id)}</code>.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate(tp._id)}
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
          Prompt Library
          <HelpTooltip
            text="Reusable, content-addressed task instructions you pick when submitting a run. Prompts are deduplicated by hash so identical text shares one entry across all runs."
            docs="taskPrompts"
            size="md"
          />
        </span>
      }
      description="Reusable task instructions you can pick when submitting a run — prompts are deduplicated by hash and shared across runs"
      railStorageKey="task-prompts"
      actions={
        <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) resetDialog(); else setDialogOpen(true); }}>
          <DialogTrigger asChild>
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" /> New Task Prompt
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>New Task Prompt</DialogTitle>
              <DialogDescription>
                {dialogStep === 1
                  ? "Enter the task text. If it already exists, the existing one is returned."
                  : "Review the text and create the task prompt."}
              </DialogDescription>
            </DialogHeader>

            <Stepper steps={DIALOG_STEPS} currentStep={dialogStep} />

            {dialogStep === 1 ? (
              <>
                <div className="space-y-2">
                  <Select value={newType} onValueChange={(value) => setNewType(value as PromptType)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Prompt type" />
                    </SelectTrigger>
                    <SelectContent>
                      {visibleGates.map((gate) => (
                        <SelectItem key={gate} value={gate}>
                          {GATE_METADATA[gate].label}
                        </SelectItem>
                      ))}
                      <SelectItem value="agents.md">{promptTypeLabel("agents.md")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <TaskPromptPicker type={newType} onSelect={(text) => setNewText(text)} />
                <Textarea
                  placeholder="Enter task prompt text..."
                  value={newText}
                  onChange={(e) => setNewText(e.target.value)}
                  rows={8}
                  className="font-mono text-sm"
                />
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Info className="h-3.5 w-3.5 shrink-0" />
                  Select an existing task prompt or enter new text.
                </p>
                <DialogFooter>
                  <Button
                    onClick={() => setDialogStep(2)}
                    disabled={!newText.trim()}
                    className="gap-1.5"
                    data-command-enter
                  >
                    Continue <ArrowRight className="h-4 w-4" /> <KbdBadge />
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <pre className="whitespace-pre-wrap text-sm bg-muted p-3 rounded-md font-mono leading-relaxed max-h-[150px] overflow-y-auto">
                  {newText}
                </pre>

                <TaskPromptFeatures
                  text={newText}
                  autoExtract
                />

                {createMutation.isError && (
                  <p className="text-sm text-destructive">
                    {createMutation.error instanceof Error
                      ? createMutation.error.message
                      : "Failed to create task prompt"}
                  </p>
                )}

                <DialogFooter className="gap-2 sm:gap-0">
                  <Button variant="outline" onClick={() => { setDialogStep(1); createMutation.reset(); }} className="gap-1.5">
                    <ArrowLeft className="h-4 w-4" /> Back
                  </Button>
                  <Button
                    onClick={() => createMutation.mutate({ text: newText, type: newType })}
                    disabled={createMutation.isPending}
                    className="gap-1.5"
                    data-command-enter
                  >
                    {createMutation.isPending ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> Creating...</>
                    ) : (
                      <><Plus className="h-4 w-4" /> Create Task Prompt</>
                    )}
                    <KbdBadge />
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search task prompts..."
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
          <FilterSection title="Prompt type" defaultOpen>
            <CheckboxFilterGroup
              options={[
                ...visibleGates.map((gate) => ({ value: gate, label: GATE_METADATA[gate].label })),
                { value: "agents.md", label: promptTypeLabel("agents.md") },
              ]}
              selected={selectedTypes}
              onToggle={(value) => state.setFilter("type", selectedTypes.includes(value as PromptType) ? [] : [value])}
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
        navigate({ pathname: "/task-prompts", search: window.location.search })
      }
    >
      <div className="flex flex-col gap-3">
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          itemLabel="task prompt"
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
          getRowId={(tp) => tp._id}
          activeId={activeId}
          onRowClick={(tp) =>
            navigate({ pathname: `/task-prompts/${tp._id}/preview`, search: window.location.search })
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
            state.search
              ? "No task prompts match your search"
              : "No task prompts registered yet"
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="task prompts"
        />
      </div>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} task prompt{selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes the selected task prompts.
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

function sortKey(a: TaskPrompt, col: string): string | number {
  switch (col) {
    case "id":
      return a._id;
    case "created":
      return new Date(a.createdAt).getTime();
    default:
      return "";
  }
}
