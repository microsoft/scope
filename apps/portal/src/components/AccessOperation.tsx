// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ProjectRole } from "shared/rbac";

interface AccessChange {
  id: string;
  path: string;
  method: "PUT" | "DELETE" | "POST";
  body: { revision: number; role?: ProjectRole };
  description: string;
}
interface OperationResult { operationId: string; state: "completed" | "pending"; revision: number }
export function useAccessOperation(onExecute: () => void) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AccessChange>();
  const refresh = () => Promise.all(
    ["access-projects", "access-members", "access-users", "access-platform-admins", "projects"]
      .map(key => queryClient.invalidateQueries({ queryKey: [key] })),
  );
  const execute = async (change: AccessChange) => {
    setBusy(true); setPending(change); onExecute(); setError(""); setMessage("");
    try {
      const result = await api.accessRequest<OperationResult>(change.path, change.method, change.body, change.id);
      if (result.state !== "completed") throw new Error("Access change is pending operator repair");
      setPending(undefined); setMessage(`${change.description} completed.`);
    } catch (cause) {
      const terminal = cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status);
      if (terminal) setPending(undefined);
      setError(`${cause instanceof Error ? cause.message : "Access change failed"} (operation ${change.id})`);
    } finally { await refresh(); setBusy(false); }
  };
  return { message, setMessage, error, setError, busy, pending, refresh, execute };
}

type AccessOperation = ReturnType<typeof useAccessOperation>;

export function AccessOperationStatus({ operation }: { operation: AccessOperation }) {
  const { error, message, pending, busy, execute } = operation;
  return <>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm">{message}</p>}
    {pending && <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
      <p>Completion is not confirmed. Retry the identical change or contact an operator with operation ID <code>{pending.id}</code> before making another change.</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void execute(pending)}>Retry change</Button>
    </div>}
  </>;
}

export function PendingAccessChange({ operationId }: { operationId?: string }) {
  return <span className="inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <Badge variant="secondary">Change pending</Badge>
    <span>Contact an operator. {operationId ? <>Operation ID: <code>{operationId}</code></> : "Operation ID unavailable."}</span>
  </span>;
}
