// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Boxes, FileCode2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ResourceRevisionDocument } from "@/types";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function ResourceDetail() {
  const { id, revisionId } = useParams();
  const navigate = useNavigate();

  const { data: resource, isLoading, error } = useQuery({
    queryKey: ["resource", id],
    queryFn: () => api.getResource(id!),
    enabled: !!id,
  });

  const { data: revisions = [], isLoading: loadingRevisions } = useQuery({
    queryKey: ["resource-revisions", id],
    queryFn: () => api.listResourceRevisions(id!, 50),
    enabled: !!id,
  });

  const latestRevision = useMemo(() => {
    if (resource?.latestRevisionId) {
      return revisions.find((revision) => revision._id === resource.latestRevisionId) ?? revisions[0] ?? null;
    }
    return revisions[0] ?? null;
  }, [resource?.latestRevisionId, revisions]);

  const revisionInList = revisionId
    ? revisions.find((revision) =>
        revision._id === revisionId
        || revision.ref === revisionId
        || String(revision.revisionNumber) === revisionId
      ) ?? null
    : null;

  const { data: fetchedRevision } = useQuery({
    queryKey: ["resource-revision", revisionId],
    queryFn: () => api.getResourceRevision(revisionId!),
    enabled: !!revisionId && !revisionInList && !loadingRevisions && !/^\d+$/.test(revisionId),
  });

  const selectedRevision = revisionId
    ? revisionInList ?? fetchedRevision ?? null
    : latestRevision;

  const selectRevision = (revision: ResourceRevisionDocument) => {
    if (revision._id === latestRevision?._id) navigate(`/resources/${id}`);
    else navigate(`/resources/${id}/revisions/${revision._id}`);
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (error || !resource) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/resources")}><ArrowLeft className="h-4 w-4" /> Back to Resources</Button>
        <div className="py-12 text-center text-muted-foreground">Resource not found</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/resources")}><ArrowLeft className="h-4 w-4" /> Back to Resources</Button>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Boxes className="h-6 w-6" />
            <h1 className="truncate text-2xl font-bold tracking-tight">{resource.name}</h1>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p className="font-mono text-sm text-muted-foreground">{resource.slug}</p>
            <Badge variant="outline" className="text-xs">{resource.revisionCounter} revision{resource.revisionCounter === 1 ? "" : "s"}</Badge>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="min-w-0">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileCode2 className="h-4 w-4 shrink-0" />
                  <span className="truncate font-mono">{selectedRevision?.ref ?? "No revision"}</span>
                  {selectedRevision && selectedRevision._id === latestRevision?._id && <Badge variant="secondary" className="text-[10px]">latest</Badge>}
                </CardTitle>
                <CardDescription>
                  Immutable lifecycle snapshot. Selecting an older revision shows exactly the scripts and exports that revision declared.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loadingRevisions ? (
              <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-32 w-full" /></div>
            ) : !selectedRevision ? (
              <div className="py-12 text-center text-sm text-muted-foreground">No revisions yet.</div>
            ) : (
              <div className="space-y-5">
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  <Detail label="Revision"><span className="font-mono text-xs">{selectedRevision.ref}</span></Detail>
                  <Detail label="Created"><span className="text-xs text-muted-foreground">{formatDate(selectedRevision.createdAt)}</span></Detail>
                  {selectedRevision.creator && <Detail label="Creator"><span className="text-xs">{selectedRevision.creator}</span></Detail>}
                  <Detail label="Content SHA-256" className="sm:col-span-2"><span className="break-all font-mono text-xs">{selectedRevision.contentSha256}</span></Detail>
                  <Detail label="Revision ID" className="sm:col-span-2"><span className="break-all font-mono text-xs text-muted-foreground">{selectedRevision._id}</span></Detail>
                </dl>

                <ScriptBlock title="Setup" body={selectedRevision.setup.sh} required />
                <ScriptBlock title="Teardown" body={selectedRevision.teardown?.sh} />

                <div className="grid gap-3 lg:grid-cols-2">
                  <InterfacePanel
                    title="Parameters"
                    description="Inputs supplied before setup starts."
                    count={selectedRevision.parameters?.length ?? 0}
                  >
                    {selectedRevision.parameters?.length ? (
                      <div className="space-y-2">
                        {selectedRevision.parameters.map((parameter) => (
                          <div key={parameter.name} className="rounded-md border bg-background p-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-xs font-medium">{parameter.name}</span>
                              {parameter.required ? (
                                <Badge variant="destructive" className="text-[10px]">required</Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px]">optional</Badge>
                              )}
                              {parameter.default !== undefined && (
                                <Badge variant="secondary" className="font-mono text-[10px]">default: {parameter.default}</Badge>
                              )}
                            </div>
                            {parameter.description && (
                              <p className="mt-1 text-xs text-muted-foreground">{parameter.description}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">This revision does not declare parameter inputs.</p>
                    )}
                  </InterfacePanel>

                  <InterfacePanel
                    title="Exports"
                    description="Outputs published after setup completes."
                    count={selectedRevision.exports.length}
                  >
                    {selectedRevision.exports.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedRevision.exports.map((name) => (
                          <Badge key={name} variant="secondary" className="font-mono text-[11px]">{name}</Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">This revision does not declare exported values.</p>
                    )}
                  </InterfacePanel>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Slug"><span className="font-mono text-xs">{resource.slug}</span></Detail>
              <Detail label="Latest revision"><span className="font-mono text-xs">{latestRevision?.ref ?? "—"}</span></Detail>
              {resource.description && <Detail label="Description"><span className="text-xs">{resource.description}</span></Detail>}
              <Detail label="Created"><span className="text-xs text-muted-foreground">{formatDate(resource.createdAt)}</span></Detail>
              {resource.updatedAt && <Detail label="Updated"><span className="text-xs text-muted-foreground">{formatDate(resource.updatedAt)}</span></Detail>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Revisions</CardTitle>
              <CardDescription className="text-xs">Immutable history. The latest pointer can move; old rows never change.</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingRevisions ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
              ) : revisions.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">No revisions yet.</p>
              ) : (
                <div className="space-y-1">
                  {revisions.map((revision) => (
                    <button
                      key={revision._id}
                      type="button"
                      onClick={() => selectRevision(revision)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        revision._id === selectedRevision?._id ? "border border-primary/20 bg-primary/10" : "hover:bg-muted",
                      )}
                    >
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-mono">{revision.ref}</span>
                      {revision._id === latestRevision?._id && <Badge variant="secondary" className="text-[10px]">latest</Badge>}
                      <span className="ml-auto whitespace-nowrap text-muted-foreground">{revision.exports.length} export{revision.exports.length === 1 ? "" : "s"}</span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={className}><span className="text-xs text-muted-foreground">{label}</span><div className="break-all">{children}</div></div>;
}

function InterfacePanel({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Badge variant="outline" className="text-[10px]">{count}</Badge>
      </div>
      {children}
    </section>
  );
}

function ScriptBlock({ title, body, required = false }: { title: string; body?: string; required?: boolean }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {!body && !required && <Badge variant="outline" className="text-[10px]">optional</Badge>}
      </div>
      {body ? (
        <pre className="max-h-80 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed">
          <code>{body}</code>
        </pre>
      ) : (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {required ? "No script body for sh." : "No teardown script for this revision."}
        </p>
      )}
    </section>
  );
}
