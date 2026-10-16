// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import type { ReportTemplate, ReportTrigger } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Trash2 } from "lucide-react";
import { truncate } from "@/lib/utils";
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

const TRIGGER_TYPES = ["always", "criteria", "taskPrompt", "promptFeature"] as const;
const FILTER_KEYS = ["trigger"] as const;

function triggerSummary(trigger?: ReportTrigger): string {
  if (!trigger) return "always (no trigger configured)";
  switch (trigger.type) {
    case "always": return "always";
    case "criteria":
      return `criteria: ${trigger.criteriaIds.join(", ")} (match: ${trigger.match ?? "all"})`;
    case "taskPrompt":
      return `taskPrompt: ${trigger.taskPromptIds.join(", ")}`;
    case "promptFeature":
      return `promptFeature: ${trigger.featureIds.join(", ")} (match: ${trigger.match ?? "all"})`;
    default:
      return "unknown";
  }
}

function triggerType(trigger?: ReportTrigger): string {
  return trigger?.type ?? "always";
}

function triggerVariant(type: string): "default" | "secondary" | "outline" | "destructive" {
  switch (type) {
    case "always": return "default";
    case "criteria": return "secondary";
    case "taskPrompt": return "outline";
    case "promptFeature": return "outline";
    default: return "default";
  }
}

export function ReportTemplateList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const columnVisibility = useHiddenColumns({ storageKey: "report-templates", defaultHidden: [] });

  const { data: templates = [], isLoading, isRefetching } = useQuery({
    queryKey: ["report-templates"],
    queryFn: () => api.listReportTemplates(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteReportTemplate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["report-templates"] }),
  });

  const triggerOptions = useMemo(
    () =>
      TRIGGER_TYPES.map((t) => ({
        value: t,
        label: t,
        count: templates.filter((tmpl) => triggerType(tmpl.trigger) === t).length,
      })),
    [templates],
  );

  const filteredTemplates = useMemo(() => {
    const triggers = state.getFilterList("trigger");
    const q = state.search.trim().toLowerCase();
    return templates.filter((t) => {
      if (triggers.length > 0 && !triggers.includes(triggerType(t.trigger))) return false;
      if (q) {
        const blob = `${t.id} ${t.name} ${triggerType(t.trigger)}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [templates, state]);

  const total = filteredTemplates.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = filteredTemplates.slice(pageStart, pageStart + state.pageSize);

  const columnOptions: CustomizeColumnsOption[] = [
    { id: "id", label: "ID", required: true },
    { id: "name", label: "Name" },
    { id: "subject", label: "Scope" },
    { id: "trigger", label: "Trigger" },
    { id: "model", label: "Model" },
    { id: "systemPrompt", label: "Sys Prompt" },
    { id: "userPrompt", label: "User Prompt" },
  ];

  const columns: DataTableColumn<ReportTemplate>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "180px",
      cell: (t) => <span className="font-mono text-sm font-medium">{t.id}</span>,
    },
    {
      id: "name",
      header: "Name",
      width: "200px",
      hidden: columnVisibility.isHidden("name"),
      cell: (t) => <span className="text-sm">{t.name}</span>,
    },
    {
      id: "subject",
      header: "Scope",
      width: "120px",
      hidden: columnVisibility.isHidden("subject"),
      cell: (template) => (
        <Badge variant="outline">
          {template.subject === "submission" ? "Submission" : "Run"}
        </Badge>
      ),
    },
    {
      id: "trigger",
      header: "Trigger",
      hidden: columnVisibility.isHidden("trigger"),
      cell: (t) => {
        const tType = triggerType(t.trigger);
        return (
          <Badge variant={triggerVariant(tType)} className="text-xs font-mono">
            {triggerSummary(t.trigger)}
          </Badge>
        );
      },
    },
    {
      id: "model",
      header: "Model",
      width: "120px",
      hidden: columnVisibility.isHidden("model"),
      cell: (t) => (
        <span className="text-sm text-muted-foreground">
          {t.model ?? <span className="italic">default (gpt-4.1)</span>}
        </span>
      ),
    },
    {
      id: "systemPrompt",
      header: "Sys Prompt",
      width: "100px",
      hidden: columnVisibility.isHidden("systemPrompt"),
      cell: (t) => (
        <span className="text-sm text-muted-foreground">
          {t.systemPrompt ? t.systemPrompt.mode : "—"}
        </span>
      ),
    },
    {
      id: "userPrompt",
      header: "User Prompt",
      hidden: columnVisibility.isHidden("userPrompt"),
      cell: (t) => (
        <span className="text-sm text-muted-foreground">{truncate(t.userPrompt, 80)}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right",
      cell: (t) => (
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
              <AlertDialogTitle>Delete template?</AlertDialogTitle>
              <AlertDialogDescription>
                This will delete <strong>{t.id}</strong>. Existing reports generated from this template will not be affected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate(t.id)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ),
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
          title="Report Templates"
          description="Manage report generation templates and their triggers"
          railStorageKey="report-templates"
          actions={
            <Button size="sm" className="gap-1.5" onClick={() => navigate("/reports/templates/new")}>
              <Plus className="h-4 w-4" /> New Template
            </Button>
          }
          filterRail={
            <FilterRail
              search={state.search}
              onSearchChange={state.setSearch}
              searchPlaceholder="Search templates…"
              refreshing={isRefetching}
              footer={
                <>
                  <ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} />
                  <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
                </>
              }
            >
              <FilterSection title="Trigger" storageKey="report-templates-trigger">
                <CheckboxFilterGroup
                  options={triggerOptions}
                  selected={state.getFilterList("trigger")}
                  onToggle={(v) => state.toggleFilterValue("trigger", v)}
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
        >
          <div className="flex flex-col gap-3">
            <DataTable
              items={pageItems}
              columns={columns}
              getRowId={(t) => t.id}
              onRowClick={(t) => navigate(`/reports/templates/${t.id}`)}
              sort={state.sort}
              sortDir={state.sortDir}
              onSortChange={state.toggleSort}
              loading={isLoading}
              loadingRows={state.pageSize}
              emptyState={
                state.hasActiveFilters
                  ? "No templates match your filters"
                  : "No report templates defined yet. Reports will use the default prompt."
              }
            />
            <Pagination
              page={state.page}
              pageSize={state.pageSize}
              total={total}
              onPageChange={state.setPage}
              onPageSizeChange={state.setPageSize}
              itemLabel="templates"
            />
          </div>
        </ListLayout>
      </div>
    </div>
  );
}
