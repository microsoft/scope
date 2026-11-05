// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, CircleCheck, FolderKanban, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ProjectCreateForm } from "@/components/ProjectCreateForm";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DataTable, ListLayout, type DataTableColumn } from "@/components/list-layout";
import { useProjectContext } from "@/contexts/ProjectContext";
import { useSelectProject } from "@/hooks/useSelectProject";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { formatDate } from "@/lib/utils";
import type { Project } from "@/types";

/** Stable id accessor — the API mirrors `_id` onto `id`, but fall back defensively. */
function projectId(project: Project): string {
  return project.id ?? project._id;
}

const NAME_MAX = 128;
const DESCRIPTION_MAX = 512;

/** Inline rename / re-describe dialog. */
function EditProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");

  const updateMutation = useMutation({
    mutationFn: () =>
      api.updateProject(projectId(project), {
        name: name.trim(),
        description: description.trim(),
        revision: project.revision ?? 0,
      }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`Project "${updated.name}" updated`);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to update project");
    },
  });

  const nameTooLong = name.length > NAME_MAX;
  const descriptionTooLong = description.length > DESCRIPTION_MAX;
  const canSubmit = !!name.trim() && !nameTooLong && !descriptionTooLong;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>Rename or re-describe this project.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit && !updateMutation.isPending) updateMutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="edit-project-name">Name *</Label>
            <Input
              id="edit-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={nameTooLong ? "border-destructive" : undefined}
            />
            {nameTooLong && (
              <p className="text-xs text-destructive">
                Name must be {NAME_MAX} characters or fewer
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-project-description">Description</Label>
            <Textarea
              id="edit-project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={descriptionTooLong ? "border-destructive" : undefined}
            />
            {descriptionTooLong && (
              <p className="text-xs text-destructive">
                Description must be {DESCRIPTION_MAX} characters or fewer
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || updateMutation.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Projects management page — list, create, rename/describe, and soft-delete
 * projects. Projects are the top-level **unscoped** container, so this page is
 * not wrapped in `ProjectGate` and works with no project selected.
 */
export function Projects() {
  const { user, authEnabled } = useAuth();
  const platformAdmin = Boolean(user?.capabilities?.platformAdmin);
  const canManageProjects = !authEnabled || platformAdmin;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { selectedProjectId } = useProjectContext();
  const selectProject = useSelectProject();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const canReadProject = (project: Project) =>
    !authEnabled || Boolean(user?.capabilities?.memberships.some(m => m.projectId === projectId(project) && m.permissions.includes("content:read")));

  /**
   * Select a project and open its dashboard. Selecting scopes the whole portal
   * to that project (see `useSelectProject`); we then redirect to `/statistics`
   * so the user lands on the project's overview. Wired to both the row click and
   * the "Use project" button so the two entry points behave identically.
   */
  const openProject = (project: Project) => {
    // Deleted projects are not selectable — they must be restored first.
    if (project.deletedAt || !canReadProject(project)) return;
    const id = projectId(project);
    if (id !== selectedProjectId) selectProject(id);
    navigate("/statistics");
  };

  const { data: projects = [], isLoading, error } = useQuery({
    queryKey: includeDeleted ? ["projects", { includeDeleted: true }] : ["projects"],
    queryFn: () => api.listProjects({ includeDeleted: !authEnabled && includeDeleted }),
  });

  const visibleProjects = useMemo(
    () => projects.filter(p => (!p.deletedAt || (!authEnabled && includeDeleted)) && (!authEnabled || user?.capabilities?.memberships.some(
      m => m.projectId === projectId(p) && m.permissions.includes("content:read"),
    ))),
    [projects, user?.capabilities?.memberships, authEnabled, includeDeleted],
  );

  const restoreMutation = useMutation({
    mutationFn: (project: Project) => api.restoreProject(projectId(project)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project restored");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to restore project"),
  });

  const deleteMutation = useMutation({
    mutationFn: (project: Project) => api.deleteProject(projectId(project)),
    onSuccess: (_data, project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`Project "${project.name}" deleted`);
      // If the deleted project was the active selection, clear it so scoped
      // pages fall back to the first-run gate instead of a dangling scope.
      if (projectId(project) === selectedProjectId) selectProject(undefined);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to delete project");
    },
  });

  const columns: DataTableColumn<Project>[] = [
    {
      id: "name",
      header: "Name",
      cell: (p) => {
        const isActive = projectId(p) === selectedProjectId;
        const isDeleted = !!p.deletedAt;
        return (
          <div className="flex items-center gap-2">
            <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={`font-medium ${isDeleted ? "text-muted-foreground line-through" : ""}`}>
              {p.name}
            </span>
            {isDeleted ? (
              <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                <Trash2 className="h-3 w-3" />
                Deleted
              </Badge>
            ) : (
              isActive && (
                <Badge className="gap-1 text-xs">
                  <Check className="h-3 w-3" />
                  Active
                </Badge>
              )
            )}
          </div>
        );
      },
    },
    {
      id: "description",
      header: "Description",
      cell: (p) => (
        <span className="block max-w-[320px] truncate text-sm text-muted-foreground" title={p.description}>
          {p.description || "—"}
        </span>
      ),
    },
    {
      id: "created",
      header: "Created",
      width: "150px",
      cell: (p) => <span className="text-xs text-muted-foreground">{formatDate(p.createdAt)}</span>,
    },
    {
      id: "actions",
      header: "",
      width: "220px",
      align: "right",
      cell: (p) => {
        const isActive = projectId(p) === selectedProjectId;
        if (p.deletedAt) return <Button size="sm" variant="outline" disabled={restoreMutation.isPending}
          onClick={event => { event.stopPropagation(); restoreMutation.mutate(p); }}>
          <RotateCcw className="mr-1 h-4 w-4" />Restore
        </Button>;
        return (
          <div
            className="flex items-center justify-end gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            {isActive ? (
              <span className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-primary">
                <CircleCheck className="h-4 w-4" />
                In use
              </span>
            ) : (
              <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => openProject(p)}
              >
                Use project
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
            {(platformAdmin || user?.capabilities.memberships.some(m => m.projectId === projectId(p) && m.role === "admin" && m.permissions.includes("members:write"))) && <Button size="sm" variant="outline" asChild>
              <Link to={`/access?projectId=${encodeURIComponent(projectId(p))}`}>Manage access</Link>
            </Button>}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`Edit ${p.name}`}
              disabled={authEnabled && !platformAdmin && !user?.capabilities?.memberships.some(m => m.projectId === projectId(p) && m.role === "admin")}
              onClick={() => setEditing(p)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  aria-label={`Delete ${p.name}`}
                  disabled={!canManageProjects}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete project “{p.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This soft-deletes the project and hides it (along with any runs and
                    resources it contains) from the default lists. You can bring it back
                    {authEnabled ? "from Access administration." : "by selecting Show deleted on this page."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => deleteMutation.mutate(p)}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <ListLayout
        title="Projects"
        filterRail={null}
        actions={
          <div className="flex items-center gap-2">
            {!authEnabled && <Button size="sm" variant="outline" onClick={() => setIncludeDeleted(value => !value)}>
              {includeDeleted ? "Hide deleted" : "Show deleted"}
            </Button>}
            {platformAdmin && <Button size="sm" variant="outline" asChild><Link to="/access">Access administration</Link></Button>}
            <Button size="sm" className="gap-1.5" disabled={!canManageProjects} onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New project
            </Button>
          </div>
        }
      >
        <div className="p-4">
          {error ? <p role="alert" className="text-sm text-destructive">
            Project inventory unavailable: {error.message}
          </p> : <DataTable
            items={visibleProjects}
            columns={columns}
            getRowId={(p) => projectId(p)}
            activeId={selectedProjectId ?? null}
            onRowClick={openProject}
            loading={isLoading}
            emptyState={
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <FolderKanban className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {!authEnabled ? "No projects yet. Create your first project." : platformAdmin ? "No accessible projects. Create one or manage memberships in Access administration." : "No accessible projects. Ask a project or platform administrator for membership."}
                </p>
                <Button size="sm" className="gap-1.5" disabled={!canManageProjects} onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" />
                  New project
                </Button>
              </div>
            }
          />}
        </div>
      </ListLayout>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Create a project to organize runs, profiles, criteria, and more.
            </DialogDescription>
          </DialogHeader>
          <ProjectCreateForm
            onCancel={() => setCreateOpen(false)}
            onCreated={() => {
              setCreateOpen(false);
              queryClient.invalidateQueries({ queryKey: ["projects"] });
            }}
          />
        </DialogContent>
      </Dialog>

      {editing && (
        <EditProjectDialog
          project={editing}
          open={!!editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}
    </>
  );
}
