// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useContext, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { Project } from "@/types";
import { AuthContext } from "@/contexts/AuthContext";

const NAME_MAX = 128;
const DESCRIPTION_MAX = 512;

export interface ProjectCreateFormProps {
  /** Called with the freshly-created project after a successful `POST`. */
  onCreated: (project: Project) => void;
  onCancel?: () => void;
  showCancel?: boolean;
  submitLabel?: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * Reusable name + description form for creating a {@link Project}. Shared by the
 * header {@link ProjectSwitcher} dialog, the first-run {@link ProjectGate}, and
 * the `/projects` management page so create behaviour never drifts between them.
 *
 * Projects are the top-level **unscoped** container, so this form needs no
 * selected project to submit.
 */
export function ProjectCreateForm({
  onCreated,
  onCancel,
  showCancel = true,
  submitLabel = "Create project",
  autoFocus = true,
  className,
}: ProjectCreateFormProps) {
  const queryClient = useQueryClient();
  const authEnabled = useContext(AuthContext)?.authEnabled !== false;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  const createMutation = useMutation({
    mutationFn: () =>
      api.createProject({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }, operationId),
    onSuccess: (project) => {
      setOperationId(crypto.randomUUID());
      // Refresh canonical inventories instead of treating the mutation response
      // as a membership grant (an idempotent retry may follow a revocation).
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["access-projects"] });
      toast.success(`Project "${project.name}" created.${authEnabled ? " Creator access refreshes automatically." : ""}`);
      onCreated(project);
    },
    onError: (error) => {
      toast.error(`${error instanceof Error ? error.message : "Failed to create project"} (operation ${operationId})`);
    },
  });

  const nameTooLong = name.length > NAME_MAX;
  const descriptionTooLong = description.length > DESCRIPTION_MAX;
  const canSubmit = !!name.trim() && !nameTooLong && !descriptionTooLong;

  const submit = () => {
    if (canSubmit && !createMutation.isPending) createMutation.mutate();
  };

  return (
    <form
      className={className ? `space-y-4 ${className}` : "space-y-4"}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {authEnabled && <p className="text-sm text-muted-foreground">New projects grant their creator an audited project-admin membership.</p>}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="project-name">Name *</Label>
          {nameTooLong && (
            <span className="text-xs text-destructive">
              {name.length}/{NAME_MAX}
            </span>
          )}
        </div>
        <Input
          id="project-name"
          value={name}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Copilot Benchmarks"
          className={nameTooLong ? "border-destructive" : undefined}
        />
        {nameTooLong && (
          <p className="text-xs text-destructive">Name must be {NAME_MAX} characters or fewer</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="project-description">Description</Label>
          {descriptionTooLong && (
            <span className="text-xs text-destructive">
              {description.length}/{DESCRIPTION_MAX}
            </span>
          )}
        </div>
        <Textarea
          id="project-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          rows={2}
          className={descriptionTooLong ? "border-destructive" : undefined}
        />
        {descriptionTooLong && (
          <p className="text-xs text-destructive">
            Description must be {DESCRIPTION_MAX} characters or fewer
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        {showCancel && onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!canSubmit || createMutation.isPending}>
          {createMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Plus className="mr-2 h-4 w-4" />
              {submitLabel}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
