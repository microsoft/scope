// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Ellipsis, Loader2, Plus, ShieldCheck, Users } from "lucide-react";
import type { AccessUserSummary, ProjectMembershipSummary, ProjectRole } from "shared/rbac";
import { api } from "@/lib/api";
import { useProjectContext } from "@/contexts/ProjectContext";
import { useAuth } from "@/contexts/AuthContext";
import { AccessUserDialog, Person, roleLabels, userName } from "@/components/AccessUserDialog";
import { AccessOperationStatus, PendingAccessChange, useAccessOperation } from "@/components/AccessOperation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AccessAdministration() {
  const [params] = useSearchParams();
  const { user, authEnabled, isReady } = useAuth();
  const fixedProjectId = params.has("projectId") ? params.get("projectId") ?? "" : undefined;
  const platformAdmin = Boolean(user?.capabilities.platformAdmin);
  const canManage = platformAdmin || Boolean(fixedProjectId && user?.capabilities.memberships.some(
    m => m.projectId === fixedProjectId && m.role === "admin" && m.permissions.includes("members:write"),
  ));
  if (!authEnabled || !isReady || !user || !canManage) return <main className="p-10">Project membership administration is not permitted.</main>;
  return <AccessAdministrationView key={`${user.id}:${platformAdmin}:${fixedProjectId === undefined ? "all" : `project:${fixedProjectId}`}`}
    fixedProjectId={fixedProjectId} platformAdmin={platformAdmin} selfUserId={user.id} />;
}

function AccessAdministrationView({ fixedProjectId, platformAdmin, selfUserId }: {
  fixedProjectId?: string; platformAdmin: boolean; selfUserId: string;
}) {
  const { selectedProjectId } = useProjectContext();
  const [chosenProjectId, setChosenProjectId] = useState(selectedProjectId ?? "");
  const scoped = fixedProjectId !== undefined;
  const projectId = fixedProjectId ?? chosenProjectId;
  const [editor, setEditor] = useState<{ user?: AccessUserSummary; role?: ProjectRole }>();
  const [confirmation, setConfirmation] = useState<{ member: ProjectMembershipSummary; disable: boolean }>();
  const operation = useAccessOperation(() => { setEditor(undefined); setConfirmation(undefined); });
  const { setMessage, setError, busy, pending, refresh, execute } = operation;
  const projectsQuery = useQuery({
    queryKey: ["access-projects", platformAdmin ? "platform" : selfUserId, platformAdmin ? undefined : projectId],
    queryFn: async () => platformAdmin
      ? api.listProjects({ controlPlane: true, includeDeleted: true })
      : [await api.getProject(projectId)],
    retry: false,
  });
  const selectedProject = projectsQuery.data?.find(project => project._id === projectId);
  const membersQuery = useQuery({
    queryKey: ["access-members", projectId],
    enabled: Boolean(selectedProject),
    queryFn: ({ signal }) => api.listProjectMembers(projectId, signal),
    retry: false,
  });
  const members = membersQuery.data ?? [];
  const current = members.filter(member => !member.revokedAt || member.pending);
  const ready = Boolean(selectedProject && !selectedProject.deletedAt && membersQuery.isSuccess && !membersQuery.isFetching && !projectsQuery.isFetching);
  const restoreMutation = useMutation({
    mutationFn: () => api.restoreProject(projectId),
    onSuccess: () => { setError(""); setMessage("Project restored."); void refresh(); },
    onError: cause => { setMessage(""); setError(cause.message); },
  });
  const locked = busy || Boolean(pending) || restoreMutation.isPending;
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">Access administration</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage who has access to your projects and what they can do.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {scoped && platformAdmin && <Button variant="outline" asChild><Link to="/access">All project access</Link></Button>}
        <Button variant="outline" asChild><Link to="/projects">Your projects</Link></Button>
      </div>
    </header>
    <div className="max-w-xl space-y-2">
      {scoped ? <div>
        <p className="text-sm text-muted-foreground">Project</p>
        <p className="text-lg font-semibold">{selectedProject?.name ?? (projectsQuery.isPending ? "Loading project..." : "Project unavailable")}</p>
      </div> : <>
        <Label htmlFor="access-project">Project</Label>
        <select id="access-project" className="block h-10 w-full rounded-md border bg-background px-3 text-sm"
          disabled={locked || projectsQuery.isPending || projectsQuery.isError} value={projectId} onChange={event => {
            setChosenProjectId(event.target.value); setEditor(undefined); setConfirmation(undefined); setMessage(""); setError("");
          }}>
          <option value="">Select a project</option>
          {projectsQuery.data?.map(project => <option key={project._id} value={project._id}>
            {project.name} ({project._id.slice(0, 8)}){project.deletedAt ? " — deleted" : ""}
          </option>)}
        </select>
      </>}
      {projectsQuery.isError && <p role="alert" className="text-sm text-destructive">Project inventory unavailable: {projectsQuery.error.message}</p>}
      {projectsQuery.isSuccess && (scoped || projectId) && !selectedProject && <p role="alert">
        This project is unavailable.{scoped && platformAdmin ? " Open All project access to choose another project." : " Choose another project from Your projects."}
      </p>}
    </div>
    <AccessOperationStatus operation={operation} />
    <section className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 p-4">
        <h2 className="flex items-center gap-2 font-semibold"><Users aria-hidden="true" className="h-4 w-4" />Project members
          {membersQuery.isSuccess && <Badge variant="secondary">{members.filter(member => !member.revokedAt).length}</Badge>}
        </h2>
        <Button size="sm" disabled={!ready || locked} onClick={() => setEditor({})}><Plus aria-hidden="true" className="mr-2 h-4 w-4" />Add people</Button>
      </div>
      {!selectedProject ? <div className="p-10 text-center text-sm text-muted-foreground">{scoped ? "Project membership is unavailable." : "Select a project to view its members."}</div>
        : membersQuery.isError ? <div role="alert" className="p-4 text-sm text-destructive">
          Membership authority unavailable: {membersQuery.error.message}{" "}
          <Button variant="link" onClick={() => void membersQuery.refetch()}>Try again</Button>
        </div> : membersQuery.isPending ? <p role="status" className="flex items-center gap-2 p-6 text-sm"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Loading members...</p>
          : <>
            {selectedProject.deletedAt && <div className="flex items-center justify-between gap-3 border-b p-4 text-sm">
              <p className="text-muted-foreground">This project is deleted. Restore it before changing access.</p>
              {platformAdmin && <Button size="sm" variant="outline" disabled={locked} onClick={() => restoreMutation.mutate()}>Restore project</Button>}
            </div>}
            <ul aria-label="Project members" className="divide-y">
              {current.map(member => <li key={member._id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <Person user={member.user} fallback={member.userId} />
                <div className="flex flex-wrap items-center gap-2">
                  {member.user?.disabled && <Badge variant="secondary">Account disabled</Badge>}
                  {member.pending && <PendingAccessChange operationId={member.operationId} />}
                  <Badge variant="outline">{roleLabels[member.role]}</Badge>
                  <Button size="sm" variant="outline" aria-label={`Change role for ${member.user ? userName(member.user) : member.userId}`}
                    disabled={!ready || locked || member.pending || !member.user || member.user.disabled} onClick={() => setEditor({ user: member.user, role: member.role })}>Change role</Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${member.user ? userName(member.user) : member.userId}`}
                    disabled={!ready || locked || member.pending} onClick={() => setConfirmation({ member, disable: false })}>Remove</Button>
                  {platformAdmin && member.user?.role === "user" && !member.user.disabled && <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`More actions for ${userName(member.user)}`} disabled={!ready || locked}>
                      <Ellipsis aria-hidden="true" className="h-4 w-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end"><DropdownMenuItem className="text-destructive" onClick={() => setConfirmation({ member, disable: true })}>Disable account</DropdownMenuItem></DropdownMenuContent>
                  </DropdownMenu>}
                </div>
              </li>)}
              {!current.length && <li className="space-y-2 p-10 text-center text-sm text-muted-foreground">
                <Users aria-hidden="true" className="mx-auto h-8 w-8" />
                <p>No members yet. Add people to give them access to this project.</p>
              </li>}
            </ul>
          </>}
    </section>
    <p className="flex items-start gap-2 text-sm text-muted-foreground"><ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      Project admins manage membership of their own project. Only platform admins manage accounts and project lifecycle; platform administration alone does not grant project content access.</p>
    {editor && <AccessUserDialog members={members} initialUser={editor.user} initialRole={editor.role} selfUserId={platformAdmin ? undefined : selfUserId}
      searchProjectId={platformAdmin ? undefined : projectId} onClose={() => setEditor(undefined)}
      onSave={(user, role) => {
        const membership = members.find(member => member.userId === user.id);
        void execute({
          id: crypto.randomUUID(), path: `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(user.id)}`, method: "PUT",
          body: { role, revision: membership?.revision ?? 0 }, description: `${userName(user)}'s ${roleLabels[role]} access`,
        });
      }} />}
    <AlertDialog open={Boolean(confirmation)} onOpenChange={open => { if (!open) setConfirmation(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.disable ? "Disable this account?" : "Remove project access?"}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation?.disable
            ? "This disables the ordinary user's access across the entire platform. Operator recovery is required to re-enable the account."
            : !platformAdmin && confirmation?.member.userId === selfUserId
            ? "You will lose access to this project, including membership management. Another project admin or a platform administrator must restore it. No other project admin is required. Content and accepted runs stay with the project."
            : "This person will lose access to this project. Their content and accepted runs stay with the project."}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => {
            if (!confirmation) return;
            const { member, disable } = confirmation;
            const revision = disable ? member.user?.revision : member.revision;
            if (revision === undefined) { setError("User details are unavailable. Refresh the member list before disabling this account."); return; }
            void execute({
              id: crypto.randomUUID(),
              path: disable ? `/admin/users/${encodeURIComponent(member.userId)}/disable` : `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(member.userId)}`,
              method: disable ? "POST" : "DELETE", body: { revision },
              description: disable ? "Account disable" : "Project membership removal",
            });
          }}>{confirmation?.disable ? "Disable account" : "Remove access"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </main>;
}
