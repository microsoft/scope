// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ResourceDocument, ResourceParameter, ResourceRevisionDocument } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type CreatedResource = ResourceDocument & { firstRevision?: ResourceRevisionDocument };

interface ResourceCreateFormProps {
  onCreated?: (resource: CreatedResource) => void;
  onCancel?: () => void;
  className?: string;
  compact?: boolean;
}

interface ParameterDraft {
  id: string;
  name: string;
  description: string;
  required: boolean;
  defaultValue: string;
  example: string;
}

export function ResourceCreateForm({ onCreated, onCancel, className, compact = false }: ResourceCreateFormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [setupBody, setSetupBody] = useState("");
  const [teardownBody, setTeardownBody] = useState("");
  const [exportsText, setExportsText] = useState("");
  const [parameters, setParameters] = useState<ParameterDraft[]>([]);

  const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const humanize = (value: string) =>
    value.replace(/-+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

  const handleNameChange = (value: string) => {
    setName(value);
    setNameEdited(value.trim().length > 0);
    if (!slugEdited) setSlug(slugify(value));
  };

  const handleSlugChange = (value: string) => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-");
    setSlug(normalized);
    setSlugEdited(normalized.trim().length > 0);
    if (!nameEdited) setName(humanize(normalized));
  };

  const exportsList = useMemo(() => parseExports(exportsText), [exportsText]);
  const invalidExports = exportsList.filter((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  const parameterList = useMemo(() => normalizeParameters(parameters), [parameters]);
  const parameterErrors = useMemo(() => validateParameters(parameterList, exportsList), [exportsList, parameterList]);

  const resetFields = () => {
    setName("");
    setSlug("");
    setNameEdited(false);
    setSlugEdited(false);
    setDescription("");
    setSetupBody("");
    setTeardownBody("");
    setExportsText("");
    setParameters([]);
  };

  const createMutation = useMutation({
    mutationFn: () => api.createResource({
      name: name.trim(),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      setup: { sh: setupBody.trimEnd() },
      ...(teardownBody.trim() ? { teardown: { sh: teardownBody.trimEnd() } } : {}),
      exports: exportsList,
      ...(parameterList.length > 0 ? { parameters: parameterList } : {}),
    }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      toast.success(`Resource "${created.slug}" created`);
      onCreated?.(created);
      resetFields();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to create resource"),
  });

  const canCreate = name.trim().length > 0
    && setupBody.trim().length > 0
    && invalidExports.length === 0
    && parameterErrors.length === 0
    && !createMutation.isPending;

  const updateParameter = (id: string, patch: Partial<ParameterDraft>) => {
    setParameters((current) => current.map((parameter) => (
      parameter.id === id ? { ...parameter, ...patch } : parameter
    )));
  };

  const addParameter = () => {
    setParameters((current) => [
      ...current,
      {
        id: `${Date.now()}-${current.length}`,
        name: "",
        description: "",
        required: false,
        defaultValue: "",
        example: "",
      },
    ]);
  };

  return (
    <div className={cn("space-y-4", className)}>
      <div className={cn("grid gap-4", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
        <div className="space-y-2">
          <Label htmlFor="resource-name">Name *</Label>
          <Input id="resource-name" value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder="GitHub simulator" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="resource-slug">Slug</Label>
          <Input id="resource-slug" value={slug} onChange={(e) => handleSlugChange(e.target.value)} placeholder="auto-generated" className="font-mono" />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-description">Description</Label>
        <Textarea id="resource-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={compact ? 2 : 3} placeholder="What dependency this provisions for a run" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-setup">Setup script *</Label>
        <Textarea
          id="resource-setup"
          value={setupBody}
          onChange={(e) => setSetupBody(e.target.value)}
          rows={compact ? 5 : 9}
          className="font-mono text-xs"
          placeholder={'docker run -d --name github-sim ...\nprintf "SIMULATOR_URL=http://localhost:8080\\n" >> "$SCOPE_SETUP_ENV"'}
        />
        <p className="text-xs text-muted-foreground">Runs with <span className="font-mono">sh -e</span> and publishes connection details through <span className="font-mono">$SCOPE_SETUP_ENV</span>.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-teardown">Teardown script</Label>
        <Textarea
          id="resource-teardown"
          value={teardownBody}
          onChange={(e) => setTeardownBody(e.target.value)}
          rows={compact ? 3 : 6}
          className="font-mono text-xs"
          placeholder="docker rm -f github-sim >/dev/null 2>&1 || true"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-exports">Exports</Label>
        <Textarea
          id="resource-exports"
          value={exportsText}
          onChange={(e) => setExportsText(e.target.value)}
          rows={compact ? 2 : 3}
          className="font-mono text-xs"
          placeholder={"SIMULATOR_URL\nSIM_TOKEN"}
        />
        <p className="text-xs text-muted-foreground">Enter environment variable names separated by commas, spaces, or new lines.</p>
        {invalidExports.length > 0 && (
          <p className="text-xs text-destructive">Invalid export name{invalidExports.length === 1 ? "" : "s"}: {invalidExports.join(", ")}</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label>Parameters</Label>
            <p className="text-xs text-muted-foreground">
              Inputs the setup and teardown scripts read before publishing exports.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={addParameter}>
            <Plus className="h-3.5 w-3.5" />
            Add parameter
          </Button>
        </div>
        {parameters.length > 0 ? (
          <div className="space-y-2">
            {parameters.map((parameter, index) => (
              <div key={parameter.id} className="rounded-md border p-3">
                <div className={cn("grid gap-3", compact ? "grid-cols-1" : "md:grid-cols-[1fr_1fr_auto]")}>
                  <div className="space-y-1.5">
                    <Label htmlFor={`resource-param-name-${parameter.id}`} className="text-xs">Name *</Label>
                    <Input
                      id={`resource-param-name-${parameter.id}`}
                      value={parameter.name}
                      onChange={(e) => updateParameter(parameter.id, { name: e.target.value })}
                      placeholder="REPO"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`resource-param-default-${parameter.id}`} className="text-xs">Default</Label>
                    <Input
                      id={`resource-param-default-${parameter.id}`}
                      value={parameter.defaultValue}
                      onChange={(e) => updateParameter(parameter.id, { defaultValue: e.target.value })}
                      placeholder="octo/repo"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div className="flex items-end justify-between gap-3">
                    <label className="flex h-8 items-center gap-2 text-xs">
                      <Checkbox
                        checked={parameter.required}
                        onCheckedChange={(checked) => updateParameter(parameter.id, { required: checked === true })}
                      />
                      Required
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove parameter ${index + 1}`}
                      onClick={() => setParameters((current) => current.filter((item) => item.id !== parameter.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className={cn("mt-3 grid gap-3", compact ? "grid-cols-1" : "md:grid-cols-2")}>
                  <div className="space-y-1.5">
                    <Label htmlFor={`resource-param-description-${parameter.id}`} className="text-xs">Description</Label>
                    <Input
                      id={`resource-param-description-${parameter.id}`}
                      value={parameter.description}
                      onChange={(e) => updateParameter(parameter.id, { description: e.target.value })}
                      placeholder="Repository to seed in the simulator"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`resource-param-example-${parameter.id}`} className="text-xs">Example</Label>
                    <Input
                      id={`resource-param-example-${parameter.id}`}
                      value={parameter.example}
                      onChange={(e) => updateParameter(parameter.id, { example: e.target.value })}
                      placeholder="microsoft/scope"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            No parameters declared. Use parameters for run-specific inputs such as a repository name.
          </p>
        )}
        {parameterErrors.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <p className="font-medium">Parameter declarations need attention</p>
            <ul className="mt-1 list-disc pl-5">
              {parameterErrors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
        <Button type="button" size="sm" className="gap-1.5" disabled={!canCreate} onClick={() => createMutation.mutate()}>
          {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : compact ? <Plus className="h-3.5 w-3.5" /> : <Boxes className="h-3.5 w-3.5" />}
          Create resource
        </Button>
      </div>
    </div>
  );
}

function parseExports(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean))];
}

function normalizeParameters(parameters: ParameterDraft[]): ResourceParameter[] {
  return parameters
    .map((parameter) => ({
      name: parameter.name.trim(),
      description: parameter.description.trim() || undefined,
      required: parameter.required,
      default: parameter.defaultValue === "" ? undefined : parameter.defaultValue,
      example: parameter.example.trim() || undefined,
    }))
    .filter((parameter) =>
      parameter.name ||
      parameter.description ||
      parameter.required ||
      parameter.default !== undefined ||
      parameter.example,
    );
}

function validateParameters(parameters: ResourceParameter[], exportsList: string[]): string[] {
  const problems: string[] = [];
  const exports = new Set(exportsList);
  const seen = new Set<string>();

  for (const parameter of parameters) {
    if (!parameter.name) {
      problems.push("A parameter is missing a name.");
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name)) {
      problems.push(`${parameter.name} is not a valid environment variable name.`);
    }
    if (parameter.name.startsWith("SCOPE_")) {
      problems.push(`${parameter.name} uses the reserved SCOPE_* prefix.`);
    }
    if (exports.has(parameter.name)) {
      problems.push(`${parameter.name} is declared as both a parameter and an export.`);
    }
    if (seen.has(parameter.name)) {
      problems.push(`${parameter.name} is declared more than once.`);
    }
    seen.add(parameter.name);
    if (parameter.required && parameter.default !== undefined) {
      problems.push(`${parameter.name} is required but also has a default.`);
    }
  }

  return problems;
}
