// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import type { AccessUserSearchResult, AccessUserSummary, ProjectMembershipSummary, ProjectRole } from "shared/rbac";
import { ProjectRoleSchema } from "shared/rbac";
import { api } from "@/lib/api";
import { useDebounce } from "@/hooks/useDebounce";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const roleLabels: Record<ProjectRole, string> = { reader: "Reader", contributor: "Contributor", admin: "Project admin" };
const roleDescriptions: Record<ProjectRole, string> = {
  reader: "View project content, results and stored reports. Cannot make changes.",
  contributor: "Create, edit and delete project content, and submit runs. Cannot change project settings or members.",
  admin: "Manage project content, settings and membership. Only platform admins can delete the project.",
};
export const userName = (user: AccessUserSummary) => user.displayName || user.email || user.alias || user.id;

export function Person({ user, fallback }: { user?: AccessUserSummary; fallback: string }) {
  const name = user ? userName(user) : fallback;
  const address = user?.email || user?.alias;
  return <div className="flex min-w-0 items-center gap-3" title={`Scope ID: ${fallback}`}>
    <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
      {name.slice(0, 2).toUpperCase()}
    </span>
    <div className="min-w-0 text-left">
      <p className="truncate font-medium">{name}</p>
      {address && address !== name && <p className="truncate text-xs text-muted-foreground">{address}</p>}
    </div>
  </div>;
}

export function AccessUserDialog({ members = [], initialUser, initialRole, platformAdmin = false, searchProjectId, selfUserId, onClose, onSave }: {
  members?: ProjectMembershipSummary[];
  initialUser?: AccessUserSummary;
  initialRole?: ProjectRole;
  platformAdmin?: boolean;
  searchProjectId?: string;
  selfUserId?: string;
  onClose: () => void;
  onSave: (user: AccessUserSummary, role: ProjectRole) => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDebounce(search.trim(), 250);
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState(initialUser);
  const [role, setRole] = useState<ProjectRole>(initialRole ?? "reader");
  const [error, setError] = useState("");
  const scopedSearch = searchProjectId !== undefined && !platformAdmin;
  const usersQuery = useQuery({
    queryKey: ["access-users", scopedSearch ? searchProjectId : "platform", query, cursor],
    queryFn: async ({ signal }): Promise<AccessUserSearchResult> => scopedSearch
      ? api.searchProjectMembers(searchProjectId, { q: query, cursor, signal })
      : api.searchAccessUsers({ q: query, cursor, signal }),
    enabled: !initialUser,
    retry: false,
  });
  const searching = search.trim() !== query || usersQuery.isFetching;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>{platformAdmin ? "Add platform admin" : initialUser ? "Change role" : "Add people"}</DialogTitle>
        <DialogDescription>{platformAdmin
          ? "Choose an enabled user who has signed in to Scope. No invitation is sent."
          : initialUser
          ? `Update ${userName(initialUser)}'s access to this project.`
          : "Find an existing Scope user, then choose the access to grant. No invitation is sent."}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6">
        {!initialUser && <>
          <Label htmlFor="access-user-search">Search users</Label>
          <div className="relative">
            <Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input id="access-user-search" className="pl-9" placeholder="Search by name, email or Scope ID"
              value={search} maxLength={100} onChange={event => {
                setSearch(event.target.value); setCursor(undefined); setSelected(undefined);
              }} />
          </div>
          {usersQuery.isError ? <div role="alert" className="text-sm text-destructive">
            User search unavailable: {usersQuery.error.message}{" "}
            <Button variant="link" onClick={() => void usersQuery.refetch()}>Try again</Button>
          </div> : searching ? <p role="status" className="text-sm text-muted-foreground">Searching users...</p> : <>
            <ul aria-label="Available users" className="max-h-60 overflow-y-auto rounded-md border">
              {usersQuery.data?.items.map(user => {
                const membership = members.find(member => member.userId === user.id);
                const existing = !platformAdmin && Boolean(membership && !membership.revokedAt);
                const unavailableRole = platformAdmin && user.role !== "user";
                const unavailable = user.disabled || existing || Boolean(membership?.pending) || unavailableRole;
                return <li key={user.id} className="border-b last:border-0">
                  <button type="button" aria-pressed={selected?.id === user.id} disabled={unavailable}
                    className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => setSelected(user)}>
                    <div className="min-w-0"><Person user={user} fallback={user.id} /></div>
                    {unavailable ? <Badge variant="secondary">{user.disabled ? "Disabled" : unavailableRole
                      ? user.role === "admin" ? "Already a platform admin" : "Unavailable role"
                      : membership?.pending ? "Change pending" : "Already a member"}</Badge>
                      : selected?.id === user.id ? <Check aria-label="Selected" className="h-4 w-4 shrink-0 text-primary" /> : null}
                  </button>
                </li>;
              })}
              {!usersQuery.data?.items.length && <li className="p-6 text-center text-sm text-muted-foreground">No users found.</li>}
            </ul>
            <div className="flex justify-between gap-2">
              {cursor && <Button size="sm" variant="outline" onClick={() => { setCursor(undefined); setSelected(undefined); }}>Back to first page</Button>}
              {usersQuery.data?.nextCursor && <Button size="sm" variant="outline" className="ml-auto"
                onClick={() => { setCursor(usersQuery.data?.nextCursor); setSelected(undefined); }}>More users</Button>}
            </div>
          </>}
        </>}
        {selected && <div className="rounded-md border bg-muted/30 p-3"><Person user={selected} fallback={selected.id} /></div>}
        {!platformAdmin && <div className="space-y-2">
          <Label htmlFor="membership-role">Project role</Label>
          <select id="membership-role" className="block h-10 w-full rounded-md border bg-background px-3 text-sm" value={role} onChange={event => {
            const parsed = ProjectRoleSchema.safeParse(event.target.value);
            if (!parsed.success) { setError("Choose a valid project role."); return; }
            setRole(parsed.data); setError("");
          }}>
            <option value="reader">Reader</option><option value="contributor">Contributor</option><option value="admin">Project admin</option>
          </select>
          <p className="text-sm text-muted-foreground">{roleDescriptions[role]}</p>
          {initialUser?.id === selfUserId && initialRole === "admin" && role !== "admin" &&
            <p role="alert" className="text-sm text-destructive">You will lose membership-management access. A platform administrator can restore it; the project does not require another project admin.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>}
      </div>
      <DialogFooter className="border-t bg-background p-4">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={!selected || Boolean(selected.disabled) || Boolean(error) || (!initialUser && (searching || usersQuery.isError)) || (Boolean(initialUser) && role === initialRole)}
          onClick={() => { if (selected) onSave(selected, role); }}>{platformAdmin ? "Review promotion" : initialUser ? "Save role" : "Add to project"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
