// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Check, ChevronsUpDown, FolderKanban, Plus, Search, Settings2 } from "lucide-react";

import { ProjectCreateForm } from "@/components/ProjectCreateForm";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useProjectContext } from "@/contexts/ProjectContext";
import { useSelectProject } from "@/hooks/useSelectProject";
import { api } from "@/lib/api";
import { filterProjects, shouldSearchProjects } from "@/lib/project-search";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";

/** Stable id accessor — the API mirrors `_id` onto `id`, but fall back defensively. */
function projectId(project: Project): string {
  return project.id ?? project._id;
}

/**
 * Presentational dropdown for the project switcher — pure props, no data
 * fetching, context, or mutations, so it is trivially story/play-testable.
 * The {@link ProjectSwitcher} container wires it to react-query + context.
 */
export function ProjectSwitcherView({
  projects,
  activeProjectId,
  isLoading = false,
  onSelect,
  onNewProject,
  className,
}: {
  projects: Project[];
  activeProjectId?: string;
  isLoading?: boolean;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  className?: string;
}) {
  const active = projects.find((p) => projectId(p) === activeProjectId);
  // Never surface the raw id in the trigger. While the list is still loading
  // show "Loading…", and if an active id has no match once loaded (e.g. the
  // project was deleted in another tab) show a soft "Unknown project" rather
  // than a bare UUID.
  const label =
    active?.name ??
    (!activeProjectId ? "Select project" : isLoading ? "Loading…" : "Unknown project");

  // Many projects: offer a search box and scroll the list (#1311). A handful
  // keeps the plain menu.
  const [query, setQuery] = useState("");
  const searchable = !isLoading && shouldSearchProjects(projects.length);
  const visibleProjects = useMemo(
    () => (searchable ? filterProjects(projects, query) : projects),
    [projects, query, searchable],
  );

  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) setQuery(""); }}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 max-w-[12rem] gap-1.5 px-2",
            !activeProjectId && "text-action",
            className,
          )}
          aria-label="Switch project"
        >
          <FolderKanban className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {searchable && (
          <div className="relative px-1 pb-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // Keep typing in the box: the menu's typeahead would otherwise
              // treat each character as "jump to item". Escape still closes.
              onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}
              placeholder="Search projects…"
              aria-label="Search projects"
              className="h-8 pl-7 text-sm"
              autoFocus
            />
          </div>
        )}
        {isLoading ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : projects.length === 0 ? (
          <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
        ) : visibleProjects.length === 0 ? (
          <DropdownMenuItem disabled>No matching projects</DropdownMenuItem>
        ) : (
          <div className={cn(searchable && "max-h-72 overflow-y-auto")}>
            {visibleProjects.map((project) => {
              const id = projectId(project);
              const selected = id === activeProjectId;
              return (
                <DropdownMenuItem
                  key={id}
                  onClick={() => {
                    if (!selected) onSelect(id);
                  }}
                  className="gap-2"
                >
                  <span className="flex-1 truncate">{project.name}</span>
                  {selected && <Check className="h-4 w-4 shrink-0" />}
                </DropdownMenuItem>
              );
            })}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onNewProject} className="gap-2">
          <Plus className="h-4 w-4" />
          <span>New project…</span>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="gap-2">
          <Link to="/projects">
            <Settings2 className="h-4 w-4" />
            <span>Manage projects</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Header control for viewing and switching the active project (mirrors the
 * placement of {@link ThemeToggle}). Loads the project list, shows the active
 * one, lets the user switch (which invalidates scoped queries via
 * {@link useSelectProject}) or create a new project inline, and links to the
 * `/projects` management page.
 */
export function ProjectSwitcher({ className }: { className?: string }) {
  const { selectedProjectId } = useProjectContext();
  const selectProject = useSelectProject();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: projects = [], isLoading, isSuccess } = useQuery({
    queryKey: ["projects"],
    // Wrap rather than pass `api.listProjects` directly: its optional
    // `{ includeDeleted? }` arg is a weak type, so react-query's
    // QueryFunctionContext isn't assignable to it (TS "no common properties").
    queryFn: () => api.listProjects(),
  });

  // Self-heal a stale selection. `selectedProjectId` is persisted to
  // localStorage, so it outlives the project it points at: the project may be
  // deleted in another tab, or the whole database reset/restored underneath us.
  // Once the list has loaded successfully, if the selected id is absent, clear
  // it so the UI falls back to the "Select project" first-run picker instead of
  // stranding on "Unknown project" and firing scoped requests with a ghost
  // projectId (which the API rejects with 400). Gated on `isSuccess` so a failed
  // or in-flight fetch never clears a still-valid selection.
  useEffect(() => {
    if (!isSuccess || !selectedProjectId) return;
    const stillExists = projects.some((p) => projectId(p) === selectedProjectId);
    if (!stillExists) selectProject(undefined);
  }, [isSuccess, projects, selectedProjectId, selectProject]);

  return (
    <>
      <ProjectSwitcherView
        projects={projects}
        activeProjectId={selectedProjectId ?? undefined}
        isLoading={isLoading}
        onSelect={selectProject}
        onNewProject={() => setCreateOpen(true)}
        className={className}
      />

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
            onCreated={(project) => {
              setCreateOpen(false);
              // Select the new project and refresh scoped data + the list.
              selectProject(projectId(project));
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
