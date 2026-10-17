// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { api } from "@/lib/api";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { CriteriaPicker } from "@/components/CriteriaPicker";
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

/** Convert a name to a slug */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function CreateReportTemplate() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [subject, setSubject] = useState<"run" | "experiment">("run");
  const [userPrompt, setUserPrompt] = useState("");
  const [sysMode, setSysMode] = useState<"none" | "append" | "override">("none");
  const [sysContent, setSysContent] = useState("");
  const [triggerType, setTriggerType] = useState<"manual" | "always" | "criteria" | "taskPrompt" | "promptFeature" | "run-report-templates">("always");
  const [triggerIds, setTriggerIds] = useState("");
  const [triggerCriteriaIds, setTriggerCriteriaIds] = useState<string[]>([]);
  const [triggerTaskPromptIds, setTriggerTaskPromptIds] = useState<string[]>([]);
  const [triggerMatch, setTriggerMatch] = useState<"any" | "all">("all");
  const [model, setModel] = useState<string>("");
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>("");

  const { data: availableModels } = useQuery({
    queryKey: ["available-report-models"],
    queryFn: () => api.listAvailableReportModels(),
    staleTime: 5 * 60 * 1000,
  });

  const idValid = useMemo(() => /^[a-z][a-z0-9-]*$/.test(id), [id]);
  const canSubmit = name.trim().length > 0 && id.trim().length > 0 && idValid && userPrompt.trim().length > 0;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!idManuallyEdited) {
      setId(slugify(value));
    }
  };

  const createMutation = useMutation({
    mutationFn: (body: Parameters<typeof api.createReportTemplate>[0]) =>
      api.createReportTemplate(body),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["report-templates"] });
      navigate(`/reports/templates/${data.id}`);
    },
  });

  const handleSubmit = () => {
    const body: Parameters<typeof api.createReportTemplate>[0] = {
      id: id.trim(),
      subject,
      name: name.trim(),
      userPrompt: userPrompt.trim(),
    };

    if (description.trim()) body.description = description.trim();

    if (model) body.model = model;

    if (timeoutSeconds && Number(timeoutSeconds) > 0) {
      body.timeoutMs = Number(timeoutSeconds) * 1000;
    }

    // System prompt
    if (sysMode !== "none" && sysContent.trim()) {
      body.systemPrompt = { mode: sysMode, content: sysContent.trim() };
    }

    // Trigger
    if (triggerType === "always") {
      body.trigger = { type: "always" };
    } else if (triggerType !== "manual") {
      const idsArray = triggerIds.split(",").map(s => s.trim()).filter(Boolean);
      if (triggerType === "criteria") {
        body.trigger = { type: "criteria", criteriaIds: triggerCriteriaIds, match: triggerMatch };
      } else if (triggerType === "taskPrompt") {
        body.trigger = { type: "taskPrompt", taskPromptIds: triggerTaskPromptIds };
      } else if (triggerType === "promptFeature") {
        body.trigger = { type: "promptFeature", featureIds: idsArray, match: triggerMatch };
      } else if (triggerType === "run-report-templates") {
        body.trigger = { type: "run-report-templates", reportTemplateIds: idsArray };
      }
    }

    createMutation.mutate(body);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/reports/templates" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">New Report Template</h1>
          <p className="text-muted-foreground">Create a reusable report generation template</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Template Configuration</CardTitle>
          <CardDescription>Define the template's identity, prompts, and trigger rules</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Identity */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g., Failure Analysis"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="id">ID (slug) *</Label>
              <Input
                id="id"
                value={id}
                onChange={(e) => { setId(e.target.value); setIdManuallyEdited(true); }}
                placeholder="e.g., failure-analysis"
                className={`font-mono ${id && !idValid ? "border-destructive" : ""}`}
              />
              {id && !idValid && (
                <p className="text-xs text-destructive">Must start with a letter, use only lowercase letters, digits, and hyphens</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description of what this template does"
            />
          </div>
          <div className="space-y-2">
            <Label>Subject</Label>
            <Select
              value={subject}
              onValueChange={(value) => {
                const next = value as "run" | "experiment";
                setSubject(next);
                setTriggerType(next === "experiment" ? "manual" : "always");
              }}
            >
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="run">Run</SelectItem>
                <SelectItem value="experiment">Experiment</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* User Prompt */}
          <div className="space-y-2">
            <Label htmlFor="userPrompt">User Prompt *</Label>
            <Textarea
              id="userPrompt"
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              rows={8}
              className="font-mono text-sm"
            />
          </div>

          <Separator />

          {/* Model */}
          <div className="space-y-2">
            <Label>Model (optional)</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Override the model used for report generation. The default is <code className="text-xs bg-muted px-1 py-0.5 rounded">gpt-4.1</code> (configurable via <code className="text-xs bg-muted px-1 py-0.5 rounded">REPORT_MODEL</code> env var).
            </p>
            <Select value={model || "__default__"} onValueChange={(v) => setModel(v === "__default__" ? "" : v)}>
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

          {/* Timeout */}
          <div className="space-y-2">
            <Label htmlFor="timeout">Timeout (optional)</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Maximum time for report generation in seconds. Default is <code className="text-xs bg-muted px-1 py-0.5 rounded">300</code> (5 minutes).
            </p>
            <Input
              id="timeout"
              type="number"
              min={1}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              placeholder="300"
              className="w-32"
            />
          </div>

          <Separator />

          {/* System Prompt */}
          <div className="space-y-2">
            <Label>System Prompt (optional)</Label>
            <Select value={sysMode} onValueChange={(v) => setSysMode(v as "none" | "append" | "override")}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (use default)</SelectItem>
                <SelectItem value="append">Append to default</SelectItem>
                <SelectItem value="override">Override default</SelectItem>
              </SelectContent>
            </Select>
            {sysMode !== "none" && (
              <Textarea
                value={sysContent}
                onChange={(e) => setSysContent(e.target.value)}
                rows={4}
                className="font-mono text-sm"
                placeholder={sysMode === "append" ? "Additional system instructions..." : "Complete system prompt..."}
              />
            )}
            <DefaultSystemPromptViewer />
          </div>

          <Separator />

          {/* Trigger */}
          <div className="space-y-2">
            <Label>Trigger</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Controls when this template is used for automatic report generation after a run completes
            </p>
            <Select value={triggerType} onValueChange={(v) => setTriggerType(v as any)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {subject === "experiment" && (
                  <SelectItem value="manual">Manual selection</SelectItem>
                )}
                <SelectItem value="always">Always</SelectItem>
                {subject === "run" ? (
                  <>
                    <SelectItem value="criteria">Criteria match</SelectItem>
                    <SelectItem value="taskPrompt">Task Prompt match</SelectItem>
                    <SelectItem value="promptFeature">Prompt Feature match</SelectItem>
                  </>
                ) : (
                  <SelectItem value="run-report-templates">Linked run reports</SelectItem>
                )}
              </SelectContent>
            </Select>
            {triggerType === "criteria" && (
              <CriteriaPicker selected={triggerCriteriaIds} onChange={setTriggerCriteriaIds} />
            )}
            {triggerType === "taskPrompt" && (
              <TaskPromptIdPicker selected={triggerTaskPromptIds} onChange={setTriggerTaskPromptIds} />
            )}
            {triggerType === "promptFeature" && (
              <>
                <Input
                  value={triggerIds}
                  onChange={(e) => setTriggerIds(e.target.value)}
                  placeholder="feature_1, feature_2"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">Comma-separated IDs</p>
              </>
            )}
            {triggerType === "run-report-templates" && (
              <>
                <Input
                  value={triggerIds}
                  onChange={(e) => setTriggerIds(e.target.value)}
                  placeholder="run-template-1, run-template-2"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Active run-template IDs; all must be assigned in the exact Experiment execution.
                </p>
              </>
            )}
            {(triggerType === "criteria" || triggerType === "promptFeature") && (
              <Select value={triggerMatch} onValueChange={(v) => setTriggerMatch(v as "any" | "all")}>
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

          {/* Submit */}
          <div className="flex gap-2">
            <Button onClick={handleSubmit} disabled={!canSubmit || createMutation.isPending} className="gap-1.5">
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Template
            </Button>
            <Link to="/reports/templates">
              <Button variant="ghost">Cancel</Button>
            </Link>
          </div>
          {createMutation.isError && (
            <p className="text-sm text-destructive">
              Failed to create: {createMutation.error instanceof Error ? createMutation.error.message : "Unknown error"}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
