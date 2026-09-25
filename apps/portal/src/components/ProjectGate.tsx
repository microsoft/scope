// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban, Loader2 } from "lucide-react";

import { ProjectCreateForm } from "@/components/ProjectCreateForm";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useProjectContext } from "@/contexts/ProjectContext";
import { useSelectProject } from "@/hooks/useSelectProject";
import { api } from "@/lib/api";
import type { Project } from "@/types";

/** Stable id accessor — the API mirrors `_id` onto `id`, but fall back defensively. */
function projectId(project: Project): string {
  return project.id ?? project._id;
}

/**
 * Presentational first-run / no-selection screen. Pure props (the create form is
 * injected as {@link createSlot} so this view has no mutation of its own), which
 * makes it straightforward to story/play-test. {@link ProjectFirstRunScreen}
 * wires it to react-query + {@link useSelectProject}.
 */
export function ProjectFirstRunView({
  projects,
  isLoading = false,
  onSelect,
  createSlot,
}: {
  projects: Project[];
  isLoading?: boolean;
  onSelect: (id: string) => void;
  createSlot: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-action/10 text-action">
          <FolderKanban className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold">Select a project</h1>
        <p className="text-sm text-muted-foreground">
          This page is scoped to a project. Pick an existing project or create one to continue —
          there is no default project.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading projects…
        </div>
      ) : (
        projects.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your projects</CardTitle>
              <CardDescription>Choose a project to work in.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {projects.map((project) => (
                <Button
                  key={projectId(project)}
                  variant="ghost"
                  className="h-auto justify-start gap-2 px-2 py-2 text-left"
                  onClick={() => onSelect(projectId(project))}
                >
                  <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {/* min-w-0 lets this column shrink below its content width. A flex
                      item defaults to min-width:auto, so without it a long description
                      pushes the row wider than the card instead of wrapping. */}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{project.name}</span>
                    {project.description && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {project.description}
                      </span>
                    )}
                  </span>
                </Button>
              ))}
            </CardContent>
          </Card>
        )
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {projects.length > 0 ? "Create a new project" : "Create your first project"}
          </CardTitle>
          <CardDescription>Projects organize runs, profiles, criteria, and more.</CardDescription>
        </CardHeader>
        <CardContent>
          <Separator className="mb-4" />
          {createSlot}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * First-run / no-selection screen shown by {@link ProjectGate} (and by the
 * unscoped home route, {@link file://./HomeRoute.tsx}). Lets the user pick an
 * existing project or create one. Selecting either fills in the scope so the
 * gated page can fire its scoped requests.
 */
export function ProjectFirstRunScreen() {
  const selectProject = useSelectProject();
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects"],
    // Wrap rather than pass `api.listProjects` directly: its optional
    // `{ includeDeleted? }` arg is a weak type, so react-query's
    // QueryFunctionContext isn't assignable to it (TS "no common properties").
    queryFn: () => api.listProjects(),
  });

  return (
    <ProjectFirstRunView
      projects={projects}
      isLoading={isLoading}
      onSelect={selectProject}
      createSlot={
        <ProjectCreateForm
          showCancel={false}
          submitLabel="Create & open"
          onCreated={(project) => selectProject(projectId(project))}
        />
      }
    />
  );
}

/**
 * Route-level guard for **scoped** pages (mirrors `FeatureRoute`). When no
 * project is selected it renders the first-run pick/create screen instead of the
 * page, so scoped pages never fire a `?projectId=`-less request that would 400.
 * Unscoped routes (agents, models, secrets, admin, `/projects`) are not wrapped
 * and stay reachable without a selection.
 */
export function ProjectGate({ children }: { children: ReactNode }) {
  const { hasProject } = useProjectContext();
  if (!hasProject) return <ProjectFirstRunScreen />;
  return <>{children}</>;
}
