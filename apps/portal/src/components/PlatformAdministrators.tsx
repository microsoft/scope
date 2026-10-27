// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, ShieldCheck } from "lucide-react";
import type { AccessUserSummary } from "shared/rbac";
import { api } from "@/lib/api";
import { AccessUserDialog, Person, userName } from "@/components/AccessUserDialog";
import { AccessOperationStatus, PendingAccessChange, useAccessOperation } from "@/components/AccessOperation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function PlatformAdministrators() {
  const [adminEditor, setAdminEditor] = useState(false);
  const [promotion, setPromotion] = useState<AccessUserSummary>();
  const [adminCursor, setAdminCursor] = useState<string>();
  const operation = useAccessOperation(() => { setAdminEditor(false); setPromotion(undefined); });
  const { busy, pending, execute } = operation;
  const locked = busy || Boolean(pending);
  const adminsQuery = useQuery({
    queryKey: ["access-platform-admins", adminCursor],
    queryFn: ({ signal }) => api.listPlatformAdmins({ cursor: adminCursor, signal }),
    retry: false,
  });
  return <div className="space-y-4">
    <section aria-labelledby="platform-admins-heading" className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 p-4">
        <h2 id="platform-admins-heading" className="flex items-center gap-2 font-semibold"><ShieldCheck aria-hidden="true" className="h-4 w-4" />Platform administrators</h2>
        <Button size="sm" disabled={locked || !adminsQuery.isSuccess || adminsQuery.isFetching}
          onClick={() => setAdminEditor(true)}><Plus aria-hidden="true" className="mr-2 h-4 w-4" />Add platform admin</Button>
      </div>
      <p className="border-b p-4 text-sm text-muted-foreground">Platform admins manage users, memberships and project lifecycle across the platform.
        Project content still requires membership. Removal, demotion and account recovery remain operator-only.</p>
      {Boolean(operation.error || operation.message || pending) && <div className="space-y-3 p-4"><AccessOperationStatus operation={operation} /></div>}
      {adminsQuery.isError ? <div role="alert" className="p-4 text-sm text-destructive">
        Platform administrator list unavailable: {adminsQuery.error.message}{" "}
        <Button variant="link" onClick={() => void adminsQuery.refetch()}>Try again</Button>
      </div> : adminsQuery.isPending ? <p role="status" className="flex items-center gap-2 p-6 text-sm">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Loading platform administrators...</p> : <>
        <ul aria-label="Platform administrators" className="divide-y">
          {adminsQuery.data.items.map(user => <li key={user.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
            <Person user={user} fallback={user.id} />
            <div className="flex items-center gap-2">
              {user.disabled && <Badge variant="secondary">Account disabled</Badge>}
              {user.pending && <PendingAccessChange operationId={user.operationId} />}
              <Badge variant="outline">{user.disabled || user.pending ? "Platform admin (inactive)" : "Platform admin"}</Badge>
            </div>
          </li>)}
          {!adminsQuery.data.items.length && <li className="p-6 text-center text-sm text-muted-foreground">No platform administrators on this page.</li>}
        </ul>
        {(adminCursor || adminsQuery.data.nextCursor) && <div className="flex justify-between gap-2 border-t p-4">
          {adminCursor && <Button size="sm" variant="outline" disabled={locked || adminsQuery.isFetching} onClick={() => setAdminCursor(undefined)}>Back to first admin page</Button>}
          {adminsQuery.data.nextCursor && <Button size="sm" variant="outline" className="ml-auto" disabled={locked || adminsQuery.isFetching}
            onClick={() => setAdminCursor(adminsQuery.data.nextCursor)}>More administrators</Button>}
        </div>}
      </>}
    </section>
    {adminEditor && <AccessUserDialog platformAdmin onClose={() => setAdminEditor(false)}
      onSave={user => { setAdminEditor(false); setPromotion(user); }} />}
    <AlertDialog open={Boolean(promotion)} onOpenChange={open => { if (!open) setPromotion(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Grant platform administration?</AlertDialogTitle>
          <AlertDialogDescription>
            {promotion ? userName(promotion) : "This user"} will be able to manage users, promote other platform admins, manage memberships and create or delete projects across the entire platform.
            This does not grant project content access. Demotion requires an operator.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={locked} onClick={() => {
            if (!promotion || locked) return;
            setAdminCursor(undefined);
            void execute({
              id: crypto.randomUUID(), path: `/admin/users/${encodeURIComponent(promotion.id)}/promote`, method: "POST",
              body: { revision: promotion.revision }, description: `${userName(promotion)}'s platform-admin promotion`,
            });
          }}>Grant platform admin</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
