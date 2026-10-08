// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isAgentAvailable, type CodingAgent, type AgentVersion } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Loader2, Save, Plus, X, Star } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { DetailPanel } from "@/components/list-layout";

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: agent, isLoading, error } = useQuery({
    queryKey: ["agent", id, "include-deleted"],
    queryFn: () => api.getAgent(id!, { includeDeleted: true }),
    enabled: !!id,
  });

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [newModel, setNewModel] = useState("");

  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setDescription(agent.description ?? "");
      setModels([...agent.supportedModels]);
      setDefaultModel(agent.defaultModel ?? "");
    }
  }, [agent]);

  const updateMutation = useMutation({
    mutationFn: (body: Partial<Pick<CodingAgent, "name" | "description" | "supportedModels" | "defaultModel">>) =>
      api.updateAgent(id!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", id] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setEditing(false);
      toast.success("Agent updated");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteAgent(id!),
    onSuccess: () => {
      toast.success("Agent deleted");
      navigate("/agents");
    },
  });

  const closePanel = () => navigate("/agents");

  const handleSave = () => {
    updateMutation.mutate({
      name,
      description: description.trim() || undefined,
      supportedModels: models,
      defaultModel: defaultModel || undefined,
    });
  };

  const handleAddModel = () => {
    const trimmed = newModel.trim();
    if (trimmed && !models.includes(trimmed)) {
      setModels([...models, trimmed]);
      if (models.length === 0) {
        setDefaultModel(trimmed);
      }
      setNewModel("");
    }
  };

  const handleRemoveModel = (model: string) => {
    const updated = models.filter((m) => m !== model);
    setModels(updated);
    if (defaultModel === model) {
      setDefaultModel(updated[0] ?? "");
    }
  };

  if (isLoading) {
    return (
      <DetailPanel title="Loading…" onClose={closePanel}>
        <div className="space-y-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </DetailPanel>
    );
  }

  if (error || !agent) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Agent not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-2">
          <span>{agent.name}</span>
          {agent.deletedAt && <Badge variant="destructive">Deleted</Badge>}
        </span>
      }
      subtitle={<span className="font-mono">{agent._id}</span>}
      onClose={closePanel}
    >
      <div className="space-y-4">
        {!agent.deletedAt && (
        <div className="flex items-center justify-end gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-1.5">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete agent?</AlertDialogTitle>
                <AlertDialogDescription>
                  This soft-deletes the agent. It can be re-seeded on next deployment.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteMutation.mutate()}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">Supported Models</CardTitle>
            {!agent.deletedAt && !editing ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : !agent.deletedAt ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    if (agent) {
                      setName(agent.name);
                      setDescription(agent.description ?? "");
                      setModels([...agent.supportedModels]);
                      setDefaultModel(agent.defaultModel ?? "");
                    }
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" className="gap-1" onClick={handleSave} disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            {editing ? (
              <>
                <div className="space-y-2">
                  {models.length === 0 && (
                    <p className="text-sm text-muted-foreground">No models configured.</p>
                  )}
                  {models.map((m) => (
                    <div key={m} className="flex items-center gap-2">
                      <Badge variant={m === defaultModel ? "default" : "secondary"} className="text-xs">
                        {m}
                      </Badge>
                      {m === defaultModel && (
                        <span className="text-xs text-muted-foreground">(default)</span>
                      )}
                      {m !== defaultModel && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          title="Set as default"
                          onClick={() => setDefaultModel(m)}
                        >
                          <Star className="h-3 w-3" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive"
                        onClick={() => handleRemoveModel(m)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="e.g. gpt-4.1"
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddModel();
                      }
                    }}
                    className="max-w-xs"
                  />
                  <Button variant="outline" size="sm" className="gap-1" onClick={handleAddModel}>
                    <Plus className="h-3 w-3" /> Add
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap gap-2">
                {agent.supportedModels.length > 0 ? (
                  agent.supportedModels.map((m) => (
                    <Badge key={m} variant={m === agent.defaultModel ? "default" : "secondary"}>
                      {m}
                      {m === agent.defaultModel && (
                        <Star className="ml-1 h-3 w-3 fill-current" />
                      )}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">No models configured</span>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {editing ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label>Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Description</Label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional description"
                    rows={2}
                  />
                </div>
              </div>
            ) : (
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Name</dt>
                  <dd>{agent.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Availability</dt>
                  <dd className="mt-0.5">
                    {agent.deletedAt ? (
                      <Badge variant="destructive">Deleted</Badge>
                    ) : !isAgentAvailable(agent) ? (
                      <Badge variant="secondary">Unavailable</Badge>
                    ) : (
                      <Badge variant="default">Available</Badge>
                    )}
                  </dd>
                </div>
                {agent.description && (
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground">Description</dt>
                    <dd>{agent.description}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-muted-foreground">Created</dt>
                  <dd>{formatDate(agent.createdAt)}</dd>
                </div>
                {agent.updatedAt && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Updated</dt>
                    <dd>{formatDate(agent.updatedAt)}</dd>
                  </div>
                )}
                {agent.deletedAt && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Deleted</dt>
                    <dd>{formatDate(agent.deletedAt)}</dd>
                  </div>
                )}
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Capabilities</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const caps = agent.capabilities;
              const entries: { label: string; supported: boolean }[] = [
                { label: "Reasoning Effort", supported: !!caps?.supportsReasoningEffort },
                { label: "MCP Servers", supported: !!caps?.supportsMcpServers },
                { label: "Skills", supported: !!caps?.supportsSkills },
                { label: "Extensions", supported: !!caps?.supportsExtensions },
              ];
              return (
                <div className="flex flex-wrap gap-2">
                  {entries.map(({ label, supported }) => (
                    <Badge key={label} variant={supported ? "default" : "outline"} className="gap-1.5">
                      {!supported && <span className="text-muted-foreground">—</span>}
                      {label}
                      {!supported && <span className="text-muted-foreground text-xs">Not supported</span>}
                    </Badge>
                  ))}
                </div>
              );
            })()}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Deployed Versions</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const versions = agent.versions ?? [];
              if (versions.length === 0) {
                return <p className="text-sm text-muted-foreground">No versions registered yet.</p>;
              }

              const active = versions.filter((v) => v.status === "active");
              const retired = versions.filter((v) => v.status === "retired");

              return (
                <div className="space-y-3">
                  {active.map((v) => (
                    <VersionEntry key={v.agentVersion} version={v} />
                  ))}
                  {retired.length > 0 && (
                    <div className="space-y-2 opacity-50">
                      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Retired</p>
                      {retired.map((v) => (
                        <VersionEntry key={v.agentVersion} version={v} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}

function VersionEntry({ version }: { version: AgentVersion }) {
  const componentDisplay = Object.entries(version.components)
    .map(([key, val]) => {
      const label = key
        .replace(/_VERSION$/, "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return `${label} ${val}`;
    })
    .join(", ");

  return (
    <div className="flex items-start justify-between gap-2 rounded-md border p-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{version.agentVersion}</span>
          <Badge variant={version.status === "active" ? "default" : "secondary"} className="text-xs">
            {version.status}
          </Badge>
        </div>
        <p className="break-all text-xs text-muted-foreground">{componentDisplay}</p>
        <p className="break-all font-mono text-xs text-muted-foreground">
          Build: {version.gitCommit} · {version.buildTime}
        </p>
        <p className="break-all font-mono text-xs text-muted-foreground">Queue: {version.queueName}</p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{formatDate(version.createdAt)}</span>
    </div>
  );
}
