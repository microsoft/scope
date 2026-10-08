// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Cpu } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { DetailPanel } from "@/components/list-layout";
import { AgentBadge } from "@/components/AgentBadge";

export function ModelDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: model, isLoading, error } = useQuery({
    queryKey: ["model", id],
    queryFn: () => api.getModel(id!),
    enabled: !!id,
  });

  const closePanel = () => navigate("/models");

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

  if (error || !model) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Model not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-1.5">
          <Cpu className="h-4 w-4" />
          <span className="truncate">{model.modelId}</span>
        </span>
      }
      subtitle={<span className="font-mono">{model._id}</span>}
      onClose={closePanel}
    >
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Provider</dt>
                <dd className="mt-0.5"><Badge variant="outline">{model.provider}</Badge></dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Agent</dt>
                <dd className="mt-0.5">
                  <AgentBadge agentId={model.agentId} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Status</dt>
                <dd className="mt-0.5">
                  {model.disappearedAt ? (
                    <Badge variant="secondary">Disappeared</Badge>
                  ) : (
                    <Badge variant="default">Active</Badge>
                  )}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Lifecycle</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">First Seen</dt>
                <dd className="mt-0.5 font-mono text-xs">{formatDate(model.firstSeenAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last Seen</dt>
                <dd className="mt-0.5 font-mono text-xs">{formatDate(model.lastSeenAt)}</dd>
              </div>
              {model.disappearedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Disappeared At</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(model.disappearedAt)}</dd>
                </div>
              )}
              {model.providerAvailableFrom && (
                <div>
                  <dt className="text-xs text-muted-foreground">Provider Available From</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(model.providerAvailableFrom)}</dd>
                </div>
              )}
              {model.providerEndOfLife && (
                <div>
                  <dt className="text-xs text-muted-foreground">Provider End of Life</dt>
                  <dd className="mt-0.5 font-mono text-xs text-destructive">{formatDate(model.providerEndOfLife)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {model.capabilities && Object.keys(model.capabilities).length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Capabilities</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {model.capabilities.reasoningEffort && model.capabilities.reasoningEffort.length > 0 && (
                <div>
                  <dt className="text-xs text-muted-foreground">Reasoning Effort Levels</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {model.capabilities.reasoningEffort.map((level) => (
                      <Badge key={level} variant="secondary">{level}</Badge>
                    ))}
                  </dd>
                </div>
              )}
              <dl className="grid grid-cols-2 gap-3 text-sm">
                {model.capabilities.toolCalls !== undefined && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Tool Calls</dt>
                    <dd className="mt-0.5">
                      <Badge variant={model.capabilities.toolCalls ? "default" : "secondary"}>
                        {model.capabilities.toolCalls ? "Supported" : "Not supported"}
                      </Badge>
                    </dd>
                  </div>
                )}
                {model.capabilities.vision !== undefined && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Vision</dt>
                    <dd className="mt-0.5">
                      <Badge variant={model.capabilities.vision ? "default" : "secondary"}>
                        {model.capabilities.vision ? "Supported" : "Not supported"}
                      </Badge>
                    </dd>
                  </div>
                )}
                {model.capabilities.streaming !== undefined && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Streaming</dt>
                    <dd className="mt-0.5">
                      <Badge variant={model.capabilities.streaming ? "default" : "secondary"}>
                        {model.capabilities.streaming ? "Supported" : "Not supported"}
                      </Badge>
                    </dd>
                  </div>
                )}
                {model.capabilities.adaptiveThinking !== undefined && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Adaptive Thinking</dt>
                    <dd className="mt-0.5">
                      <Badge variant={model.capabilities.adaptiveThinking ? "default" : "secondary"}>
                        {model.capabilities.adaptiveThinking ? "Supported" : "Not supported"}
                      </Badge>
                    </dd>
                  </div>
                )}
                {model.capabilities.maxThinkingBudget !== undefined && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Max Thinking Budget</dt>
                    <dd className="mt-0.5 font-mono text-xs">
                      {model.capabilities.maxThinkingBudget.toLocaleString()} tokens
                    </dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>
        )}

        {model.metadata && Object.keys(model.metadata).length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Metadata</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                {Object.entries(model.metadata).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-xs text-muted-foreground">{key}</dt>
                    <dd className="mt-0.5 font-mono text-xs break-all">
                      {typeof value === "string" || typeof value === "number"
                        ? String(value)
                        : JSON.stringify(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        )}
      </div>
    </DetailPanel>
  );
}
