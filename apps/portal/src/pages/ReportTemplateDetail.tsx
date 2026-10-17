// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { api } from "@/lib/api";
import type { ReportTrigger } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, ChevronDown, ChevronRight, Save, Trash2, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { CriteriaPicker } from "@/components/CriteriaPicker";
import { CriteriaBadge } from "@/components/CriteriaBadge";
import { TaskPromptBadge } from "@/components/TaskPromptBadge";
import { TaskPromptIdPicker } from "@/components/TaskPromptIdPicker";

function DefaultSystemPromptViewer() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["default-system-prompt"],
    queryFn: () => api.getDefaultSystemPrompt(),
    enabled: open,
    staleTime: Infinity,
  });

  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        View default system prompt
      </button>
      {open && data && (
        <div className="mt-2 max-h-64 overflow-auto rounded-md border bg-muted p-3 prose prose-sm dark:prose-invert max-w-none">
          <MarkdownRenderer>{data.content}</MarkdownRenderer>
        </div>
      )}
    </div>
  );
}

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
    case "run-report-templates":
      return `linked run reports: ${trigger.reportTemplateIds.join(", ")}`;
    default:
      return "unknown";
  }
}

export function ReportTemplateDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: template, isLoading, error } = useQuery({
    queryKey: ["report-template", id],
    queryFn: () => api.getReportTemplate(id!),
    enabled: !!id,
  });
  const { data: versions = [] } = useQuery({
    queryKey: ["report-template-versions", id],
    queryFn: () => api.listReportTemplateVersions(id!),
    enabled: !!id,
  });

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editUserPrompt, setEditUserPrompt] = useState("");
  const [editSysMode, setEditSysMode] = useState<"none" | "append" | "override">("none");
  const [editSysContent, setEditSysContent] = useState("");
  const [editTriggerType, setEditTriggerType] = useState<"manual" | "always" | "criteria" | "taskPrompt" | "promptFeature" | "run-report-templates">("always");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editTriggerIds, setEditTriggerIds] = useState("");
  const [editTriggerCriteriaIds, setEditTriggerCriteriaIds] = useState<string[]>([]);
  const [editTriggerTaskPromptIds, setEditTriggerTaskPromptIds] = useState<string[]>([]);
  const [editTriggerMatch, setEditTriggerMatch] = useState<"any" | "all">("all");
  const [editModel, setEditModel] = useState<string>("");
  const [editTimeoutSeconds, setEditTimeoutSeconds] = useState<string>("");

  const { data: availableModels } = useQuery({
    queryKey: ["available-report-models"],
    queryFn: () => api.listAvailableReportModels(),
    staleTime: 5 * 60 * 1000,
  });

  const startEditing = () => {
    if (!template) return;
    setEditName(template.name);
    setEditDescription(template.description ?? "");
    setEditUserPrompt(template.userPrompt);
    setEditSysMode(template.systemPrompt?.mode ?? "none");
    setEditSysContent(template.systemPrompt?.content ?? "");
    setEditTriggerType(
      template.trigger?.type ??
        (template.subject === "experiment" ? "manual" : "always"),
    );
    setEditEnabled(template.enabled);
    setEditTriggerIds(getTriggerIds(template.trigger).join(", "));
    setEditTriggerCriteriaIds(
      template.trigger?.type === "criteria" ? (template.trigger as any).criteriaIds ?? [] : []
    );
    setEditTriggerTaskPromptIds(
      template.trigger?.type === "taskPrompt" ? (template.trigger as any).taskPromptIds ?? [] : []
    );
    setEditTriggerMatch(
      (template.trigger?.type === "criteria" || template.trigger?.type === "promptFeature")
        ? (template.trigger as any).match ?? "all"
        : "all"
    );
    setEditModel(template.model ?? "");
    setEditTimeoutSeconds(template.timeoutMs ? String(template.timeoutMs / 1000) : "");
    setEditing(true);
  };

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.updateReportTemplate(id!, body),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["report-template", id] });
      queryClient.invalidateQueries({ queryKey: ["report-template-versions", id] });
      queryClient.invalidateQueries({ queryKey: ["report-templates"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteReportTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-templates"] });
      navigate("/reports/templates");
    },
  });

  const handleSave = () => {
    const body: Record<string, unknown> = {};
    if (editName.trim()) body.name = editName.trim();
    body.description = editDescription.trim() || undefined;
    body.enabled = editEnabled;
    if (editUserPrompt.trim()) body.userPrompt = editUserPrompt.trim();

    // Model
    body.model = editModel || null;

    // Timeout
    body.timeoutMs = editTimeoutSeconds && Number(editTimeoutSeconds) > 0
      ? Number(editTimeoutSeconds) * 1000
      : null;

    // System prompt
    if (editSysMode !== "none" && editSysContent.trim()) {
      body.systemPrompt = { mode: editSysMode, content: editSysContent.trim() };
    } else {
      body.systemPrompt = null; // Remove system prompt
    }

    // Trigger
    if (editTriggerType === "manual") {
      body.trigger = null;
    } else if (editTriggerType === "always") {
      body.trigger = { type: "always" };
    } else {
      const idsArray = editTriggerIds.split(",").map(s => s.trim()).filter(Boolean);
      if (editTriggerType === "criteria") {
        body.trigger = { type: "criteria", criteriaIds: editTriggerCriteriaIds, match: editTriggerMatch };
      } else if (editTriggerType === "taskPrompt") {
        body.trigger = { type: "taskPrompt", taskPromptIds: editTriggerTaskPromptIds };
      } else if (editTriggerType === "promptFeature") {
        body.trigger = { type: "promptFeature", featureIds: idsArray, match: editTriggerMatch };
      } else if (editTriggerType === "run-report-templates") {
        body.trigger = { type: "run-report-templates", reportTemplateIds: idsArray };
      }
    }

    updateMutation.mutate(body);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="space-y-4">
        <Link to="/reports/templates" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to templates
        </Link>
        <div className="text-center py-12 text-muted-foreground">
          Template not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/reports/templates" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{template.name}</h1>
            <p className="font-mono text-sm text-muted-foreground">{template.id}</p>
            <div className="mt-2 flex gap-2">
              <Badge variant="outline">{template.subject}</Badge>
              <Badge variant={template.enabled ? "default" : "secondary"}>
                {template.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Badge variant="secondary">Version {template.currentVersion}</Badge>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <Button variant="outline" onClick={startEditing}>Edit</Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="gap-1.5">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete template?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete <strong>{template.id}</strong>. Existing reports will not be affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate(template.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {editing ? (
        /* ── Edit mode ────────────────────────────────────────────── */
        <Card>
          <CardHeader>
            <CardTitle>Edit Template</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} placeholder="Optional description" />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={editEnabled ? "enabled" : "disabled"} onValueChange={(value) => setEditEnabled(value === "enabled")}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="enabled">Enabled</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label htmlFor="userPrompt">User Prompt</Label>
              <Textarea id="userPrompt" value={editUserPrompt} onChange={(e) => setEditUserPrompt(e.target.value)} rows={12} className="font-mono text-sm" />
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>Model (optional)</Label>
              <Select value={editModel || "__default__"} onValueChange={(v) => setEditModel(v === "__default__" ? "" : v)}>
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Default (gpt-4.1)</SelectItem>
                  {availableModels?.map((m) => (
                    <SelectItem key={m.modelId} value={m.modelId}>{m.modelId}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="editTimeout">Timeout (seconds)</Label>
              <Input
                id="editTimeout"
                type="number"
                min={1}
                value={editTimeoutSeconds}
                onChange={(e) => setEditTimeoutSeconds(e.target.value)}
                placeholder="300"
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">Default: 300 (5 minutes)</p>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>System Prompt</Label>
              <Select value={editSysMode} onValueChange={(v) => setEditSysMode(v as "none" | "append" | "override")}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (use default)</SelectItem>
                  <SelectItem value="append">Append</SelectItem>
                  <SelectItem value="override">Override</SelectItem>
                </SelectContent>
              </Select>
              {editSysMode !== "none" && (
                <Textarea value={editSysContent} onChange={(e) => setEditSysContent(e.target.value)} rows={4} className="font-mono text-sm" placeholder="System prompt content..." />
              )}
              <DefaultSystemPromptViewer />
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>Trigger</Label>
              <Select value={editTriggerType} onValueChange={(v) => setEditTriggerType(v as any)}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {template.subject === "experiment" && (
                    <SelectItem value="manual">Manual selection</SelectItem>
                  )}
                  <SelectItem value="always">Always</SelectItem>
                  {template.subject === "run" ? (
                    <>
                      <SelectItem value="criteria">Criteria</SelectItem>
                      <SelectItem value="taskPrompt">Task Prompt</SelectItem>
                      <SelectItem value="promptFeature">Prompt Feature</SelectItem>
                    </>
                  ) : (
                    <SelectItem value="run-report-templates">Linked run reports</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {editTriggerType === "criteria" && (
                <CriteriaPicker selected={editTriggerCriteriaIds} onChange={setEditTriggerCriteriaIds} />
              )}
              {editTriggerType === "taskPrompt" && (
                <TaskPromptIdPicker selected={editTriggerTaskPromptIds} onChange={setEditTriggerTaskPromptIds} />
              )}
              {editTriggerType === "promptFeature" && (
                <>
                  <Input
                    value={editTriggerIds}
                    onChange={(e) => setEditTriggerIds(e.target.value)}
                    placeholder="feature_id_1, feature_id_2"
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">Comma-separated IDs</p>
                </>
              )}
              {editTriggerType === "run-report-templates" && (
                <Input
                  value={editTriggerIds}
                  onChange={(e) => setEditTriggerIds(e.target.value)}
                  placeholder="run-template-1, run-template-2"
                  className="font-mono text-sm"
                />
              )}
              {(editTriggerType === "criteria" || editTriggerType === "promptFeature") && (
                <Select value={editTriggerMatch} onValueChange={(v) => setEditTriggerMatch(v as "any" | "all")}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Match all</SelectItem>
                    <SelectItem value="any">Match any</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            <Separator />
            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={updateMutation.isPending} className="gap-1.5">
                {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
            {updateMutation.isError && (
              <p className="text-sm text-destructive">
                Failed to update: {updateMutation.error instanceof Error ? updateMutation.error.message : "Unknown error"}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        /* ── View mode ────────────────────────────────────────────── */
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-muted-foreground text-xs">Name</Label>
                <p className="text-sm">{template.name}</p>
              </div>
              {template.description && (
                <div>
                  <Label className="text-muted-foreground text-xs">Description</Label>
                  <p className="text-sm">{template.description}</p>
                </div>
              )}
              <div>
                <Label className="text-muted-foreground text-xs">Trigger</Label>
                <div className="mt-1">
                  {template.trigger?.type === "taskPrompt" ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">taskPrompt:</span>
                      {template.trigger.taskPromptIds.map((id) => (
                        <TaskPromptBadge key={id} taskPromptId={id} />
                      ))}
                    </div>
                  ) : template.trigger?.type === "criteria" ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">criteria:</span>
                      {template.trigger.criteriaIds.map((id) => (
                        <CriteriaBadge key={id} criterionId={id} />
                      ))}
                      <span className="text-xs text-muted-foreground">
                        (match: {template.trigger.match ?? "all"})
                      </span>
                    </div>
                  ) : (
                    <Badge variant="secondary" className="text-xs font-mono">
                      {triggerSummary(template.trigger)}
                    </Badge>
                  )}
                </div>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Model</Label>
                <p className="text-sm font-mono">{template.model ?? "default (gpt-4.1)"}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Timeout</Label>
                <p className="text-sm font-mono">{template.timeoutMs ? `${template.timeoutMs / 1000}s` : "default (300s)"}</p>
              </div>
              <Separator />
              <div className="flex gap-6 text-xs text-muted-foreground">
                <span>Created: {formatDate(template.createdAt)}</span>
                {template.updatedAt && <span>Updated: {formatDate(template.updatedAt)}</span>}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>User Prompt</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm dark:prose-invert max-w-none bg-muted p-3 rounded-md">
                <MarkdownRenderer>{template.userPrompt}</MarkdownRenderer>
              </div>
            </CardContent>
          </Card>

          {template.systemPrompt && (
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle>
                  System Prompt{" "}
                  <Badge variant="outline" className="ml-2 text-xs">
                    {template.systemPrompt.mode}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="prose prose-sm dark:prose-invert max-w-none bg-muted p-3 rounded-md">
                  <MarkdownRenderer>{template.systemPrompt.content}</MarkdownRenderer>
                </div>
              </CardContent>
            </Card>
          )}
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Version History</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {versions.map((version) => (
                <div
                  key={version._id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        version._id === template.currentVersionId
                          ? "default"
                          : "outline"
                      }
                    >
                      Version {version.version}
                    </Badge>
                    {version._id === template.currentVersionId && (
                      <span className="text-xs text-muted-foreground">Current</span>
                    )}
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>{formatDate(version.createdAt)}</div>
                    <div className="font-mono">
                      {version.contentFingerprint.slice(0, 12)}
                    </div>
                  </div>
                </div>
              ))}
              {versions.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No immutable versions are available.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function getTriggerIds(trigger?: ReportTrigger): string[] {
  if (!trigger) return [];
  switch (trigger.type) {
    case "criteria": return trigger.criteriaIds;
    case "taskPrompt": return trigger.taskPromptIds;
    case "promptFeature": return trigger.featureIds;
    default: return [];
  }
}
