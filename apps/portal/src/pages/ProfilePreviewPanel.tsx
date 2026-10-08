// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, UserCog } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { AgentBadge } from "@/components/AgentBadge";

export function ProfilePreviewPanel() {
  const { profileId } = useParams<{ profileId: string }>();
  const navigate = useNavigate();

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ["profile", profileId],
    queryFn: () => api.getProfile(profileId!),
    enabled: !!profileId,
  });

  const closePanel = () =>
    navigate({ pathname: "/profiles", search: window.location.search });

  if (isLoading) {
    return (
      <DetailPanel title="Loading…" onClose={closePanel}>
        <div className="space-y-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-32 w-full" />
        </div>
      </DetailPanel>
    );
  }

  if (error || !profile) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Profile not found.</p>
      </DetailPanel>
    );
  }

  const v = profile.version;

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-1.5 truncate">
          <UserCog className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{profile.name}</span>
        </span>
      }
      subtitle={
        <span className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-xs">v{v.version}</Badge>
          <span className="font-mono text-xs">{profile._id}</span>
        </span>
      }
      onClose={closePanel}
      headerActions={
        <div className="flex justify-end">
          <Link to={`/profiles/${profile._id}`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" /> Open full view
            </Button>
          </Link>
        </div>
      }
    >
      <div className="space-y-4">
        {profile.description && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {profile.description}
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Worker</dt>
                <dd className="mt-0.5 text-xs">
                  <AgentBadge agentId={v.workerType} version={v.agentVersion} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Model</dt>
                <dd className="mt-0.5 font-mono text-xs">{v.model}</dd>
              </div>
              {v.agentVersion && (
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Agent version</dt>
                  <dd className="mt-0.5 font-mono text-xs">{v.agentVersion}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Attachments</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">MCP servers</dt>
                <dd className="mt-0.5 text-lg font-semibold">{v.mcpServers?.length ?? 0}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Skills</dt>
                <dd className="mt-0.5 text-lg font-semibold">{v.skillRevisions?.length ?? 0}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Extensions</dt>
                <dd className="mt-0.5 text-lg font-semibold">{v.extensions?.length ?? 0}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-0.5 font-mono text-xs">{formatDate(profile.createdAt)}</dd>
              </div>
              {profile.updatedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(profile.updatedAt)}</dd>
                </div>
              )}
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Latest version</dt>
                <dd className="mt-0.5 text-sm">v{profile.latestVersion}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
