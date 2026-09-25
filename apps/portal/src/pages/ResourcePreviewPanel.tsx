// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Boxes, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

interface ResourcePreviewPanelProps {
  id: string;
}

export function ResourcePreviewPanel({ id }: ResourcePreviewPanelProps) {
  const navigate = useNavigate();
  const { data: resource, isLoading, error } = useQuery({
    queryKey: ["resource", id],
    queryFn: () => api.getResource(id),
    enabled: !!id,
  });

  const { data: latestRevision } = useQuery({
    queryKey: ["resource-revision", resource?.latestRevisionId],
    queryFn: async () => resource?.latestRevisionId ? api.getResourceRevision(resource.latestRevisionId) : null,
    enabled: !!resource?.latestRevisionId,
  });

  const closePanel = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("preview");
    const search = params.toString();
    navigate({ pathname: "/resources", search: search ? `?${search}` : "" });
  };

  if (isLoading) {
    return (
      <DetailPanel title="Loading…" onClose={closePanel}>
        <div className="space-y-3"><Skeleton className="h-5 w-3/4" /><Skeleton className="h-32 w-full" /></div>
      </DetailPanel>
    );
  }

  if (error || !resource) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Resource not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={<span className="flex items-center gap-1.5 truncate"><Boxes className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{resource.name}</span></span>}
      subtitle={<span className="font-mono">{resource.slug}</span>}
      onClose={closePanel}
      headerActions={<div className="flex justify-end"><Link to={`/resources/${resource.slug}`}><Button variant="outline" size="sm" className="gap-1.5"><ExternalLink className="h-3.5 w-3.5" /> Open full view</Button></Link></div>}
    >
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-xs text-muted-foreground">Latest revision</dt><dd className="mt-0.5 font-mono text-xs">{latestRevision?.ref ?? (resource.latestRevisionNumber ? `${resource.slug}@r${resource.latestRevisionNumber}` : "None")}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Exports</dt><dd className="mt-0.5"><Badge variant="outline" className="text-xs">{latestRevision?.exports.length ?? "—"}</Badge></dd></div>
              <div><dt className="text-xs text-muted-foreground">Revision count</dt><dd className="mt-0.5 text-xs">{resource.revisionCounter}</dd></div>
            </dl>
          </CardContent>
        </Card>
        {resource.description && <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Description</CardTitle></CardHeader><CardContent><p className="whitespace-pre-wrap text-sm text-muted-foreground">{resource.description}</p></CardContent></Card>}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Latest exports</CardTitle></CardHeader>
          <CardContent>
            {latestRevision?.exports.length ? (
              <div className="flex flex-wrap gap-1.5">
                {latestRevision.exports.map((name) => <Badge key={name} variant="secondary" className="font-mono text-[11px]">{name}</Badge>)}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No exports declared.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Timeline</CardTitle></CardHeader>
          <CardContent><dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">Created</dt><dd className="mt-0.5 font-mono text-xs">{formatDate(resource.createdAt)}</dd></div>{resource.updatedAt && <div><dt className="text-xs text-muted-foreground">Updated</dt><dd className="mt-0.5 font-mono text-xs">{formatDate(resource.updatedAt)}</dd></div>}</dl></CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
