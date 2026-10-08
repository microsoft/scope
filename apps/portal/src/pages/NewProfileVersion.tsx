// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AgentBadge } from "@/components/AgentBadge";
import { useStrictAgentCapabilities } from "@/hooks/useStrictAgentCapabilities";
import {
  getActiveAgentVersions,
  isAgentAvailable,
  type CodingAgent,
  type McpServerDocument,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { SkillPicker } from "@/components/SkillPicker";
import { ExtensionPicker } from "@/components/ExtensionPicker";
import { ResourcePicker } from "@/components/ResourcePicker";
import { useModelCapabilities, useReasoningEffort, ReasoningEffortSelect, ModelSelectItems } from "@/components/ReasoningEffortSelect";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import type { ResourceBindingSpec } from "@/types";

export function NewProfileVersion() {
  const { profileId } = useParams<{ profileId: string }>();
  const navigate = useNavigate();
  const strictAgentCapabilities = useStrictAgentCapabilities();

  // Configuration fields
  const [worker, setWorker] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [selectedAgentVersion, setSelectedAgentVersion] = useState("");
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedResources, setSelectedResources] = useState<ResourceBindingSpec[]>([]);
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);

  // Fetch profile to pre-fill from latest version
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ["profile", profileId],
    queryFn: () => api.getProfile(profileId!),
    enabled: !!profileId,
  });

  // Fetch agents (workers)
  const { data: agents = [], isSuccess: agentsLoaded } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.listAgents({ includeDeleted: true }),
  });

  // Fetch MCP servers
  const { data: mcpServers = [] } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: api.listMcpServers,
  });

  // Pre-fill from latest version
  useEffect(() => {
    if (profile?.version) {
      setWorker(profile.version.workerType);
      setModel(profile.version.model);
      setReasoningEffort(profile.version.reasoningEffort ?? "");
      setSelectedAgentVersion(profile.version.agentVersion ?? "");
      setSelectedMcpServers(profile.version.mcpServers ?? []);
      setSelectedSkills(profile.version.skillRevisions ?? []);
      setSelectedResources(profile.version.resources ?? []);
      setSelectedExtensions(profile.version.extensions ?? []);
    }
  }, [profile]);

  // Find selected agent for model/version lists
  const selectedAgent = agents.find((a: CodingAgent) => a._id === worker);
  const eligibleAgents = agents.filter(isAgentAvailable);
  const selectedAgentIsEligible = !!selectedAgent && isAgentAvailable(selectedAgent);
  const supportsMcpServers = !strictAgentCapabilities || selectedAgent?.capabilities?.supportsMcpServers === true;
  const supportsSkills = !strictAgentCapabilities || selectedAgent?.capabilities?.supportsSkills === true;
  const supportsExtensions = !strictAgentCapabilities || selectedAgent?.capabilities?.supportsExtensions === true;

  // Model capabilities and effort management
  const { capabilitiesMap, activeModelIds, capabilitiesLoaded } = useModelCapabilities(worker || undefined);
  const supportedModels = activeModelIds.length > 0
    ? activeModelIds
    : (selectedAgent?.supportedModels ?? []);
  const onEffortChange = useCallback((v: string) => setReasoningEffort(v), []);
  const { supportedEfforts, workerEffortWarning } = useReasoningEffort({
    model,
    capabilitiesMap,
    value: reasoningEffort,
    onChange: onEffortChange,
    agentSupportsEffort: strictAgentCapabilities
      ? selectedAgent?.capabilities?.supportsReasoningEffort
      : true,
    capabilitiesLoaded,
  });

  // Clear selections that the newly selected worker cannot consume.
  useEffect(() => {
    if (!worker || !agentsLoaded) return;
    if (strictAgentCapabilities && selectedAgent?.capabilities?.supportsReasoningEffort !== true) {
      setReasoningEffort("");
    }
    if (!supportsMcpServers) {
      setSelectedMcpServers([]);
    }
    if (!supportsSkills) {
      setSelectedSkills([]);
    }
    if (!supportsExtensions) {
      setSelectedExtensions([]);
    }
  }, [
    worker,
    agentsLoaded,
    strictAgentCapabilities,
    selectedAgent?.capabilities?.supportsReasoningEffort,
    supportsMcpServers,
    supportsSkills,
    supportsExtensions,
  ]);

  const sortedVersions = selectedAgent ? getActiveAgentVersions(selectedAgent).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ) : [];
  const selectedVersionIsHistorical = !!selectedAgentVersion
    && !sortedVersions.some((version) => version.agentVersion === selectedAgentVersion);

  const createVersionMutation = useMutation({
    mutationFn: () => api.createProfileVersion(profileId!, {
      workerType: worker,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}),
      ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}),
      ...(selectedSkills.length > 0 ? { skillRevisions: selectedSkills } : {}),
      ...(selectedResources.length > 0 ? { resources: selectedResources } : {}),
      ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}),
    }),
    onSuccess: (data) => {
      toast.success(`Created version ${data.version} of profile`);
      navigate(`/profiles/${profileId}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to create version");
    },
  });

  if (profileLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate("/profiles")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <p className="text-muted-foreground">Profile not found.</p>
      </div>
    );
  }

  const ev = profile?.version;
  const hasChanges = !!ev && (
    worker !== ev.workerType ||
    model !== ev.model ||
    (reasoningEffort || "") !== (ev.reasoningEffort || "") ||
    (selectedAgentVersion || "") !== (ev.agentVersion || "") ||
    JSON.stringify([...selectedMcpServers].sort()) !== JSON.stringify([...(ev.mcpServers ?? [])].sort()) ||
    JSON.stringify([...selectedSkills].sort()) !== JSON.stringify([...(ev.skillRevisions ?? [])].sort()) ||
    JSON.stringify(sortResourceBindings(selectedResources)) !== JSON.stringify(sortResourceBindings(ev.resources ?? [])) ||
    JSON.stringify([...selectedExtensions].sort()) !== JSON.stringify([...(ev.extensions ?? [])].sort())
  );

  const canSubmit = worker && model && selectedAgentIsEligible && !selectedVersionIsHistorical && hasChanges;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/profiles/${profileId}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Version</h1>
          <p className="text-muted-foreground">
            Create a new immutable configuration snapshot for <span className="font-medium text-foreground">{profile.name}</span>.
            The previous version is preserved.
          </p>
        </div>
      </div>

      {/* Agent Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Configuration</CardTitle>
          <CardDescription>Worker, model, and agent version</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="worker">Worker *</Label>
            <Select value={worker} onValueChange={(v) => {
              setWorker(v);
              setModel("");
              setReasoningEffort("");
              setSelectedAgentVersion("");
            }}>
              <SelectTrigger id="worker">
                <SelectValue placeholder="Select a worker" />
              </SelectTrigger>
              <SelectContent>
                {worker && !selectedAgentIsEligible && (
                  <SelectItem value={worker} disabled>
                    <span className="flex items-center gap-1">
                      <AgentBadge
                        agentId={worker}
                        agent={selectedAgent}
                        triggerLink={false}
                      />
                      <span>(unavailable)</span>
                    </span>
                  </SelectItem>
                )}
                {eligibleAgents.map((a: CodingAgent) => (
                  <SelectItem key={a._id} value={a._id}>
                    <AgentBadge agentId={a._id} agent={a} triggerLink={false} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {supportedModels.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="model">Model *</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="model">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  <ModelSelectItems
                    models={supportedModels}
                    capabilitiesMap={capabilitiesMap}
                  />
                </SelectContent>
              </Select>
            </div>
          )}

          <ReasoningEffortSelect
            supportedEfforts={supportedEfforts}
            value={reasoningEffort}
            onChange={onEffortChange}
            workerEffortWarning={workerEffortWarning}
          />

          {(sortedVersions.length > 0 || selectedVersionIsHistorical) && (
            <div className="space-y-2">
              <Label htmlFor="agentVersion">Agent Version</Label>
              <Select value={selectedAgentVersion} onValueChange={setSelectedAgentVersion}>
                <SelectTrigger id="agentVersion">
                  <SelectValue placeholder="Select version" />
                </SelectTrigger>
                <SelectContent>
                  {selectedVersionIsHistorical && (
                    <SelectItem value={selectedAgentVersion} disabled>
                      {selectedAgentVersion} (unavailable)
                    </SelectItem>
                  )}
                  {sortedVersions.map((v, i) => (
                    <SelectItem key={v.agentVersion} value={v.agentVersion}>
                      {v.agentVersion}{i === 0 ? " (latest)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* MCP Servers */}
      {supportsMcpServers && mcpServers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>MCP Servers</CardTitle>
            <CardDescription>Select MCP servers to include in this version</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {mcpServers.map((s: McpServerDocument) => (
                <div key={s._id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`mcp-${s._id}`}
                    checked={selectedMcpServers.includes(s._id)}
                    onCheckedChange={(checked) => {
                      setSelectedMcpServers((prev) =>
                        checked ? [...prev, s._id] : prev.filter((id) => id !== s._id)
                      );
                    }}
                  />
                  <Label htmlFor={`mcp-${s._id}`} className="font-mono text-sm">{s._id}</Label>
                  <span className="text-muted-foreground text-xs">{s.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Skills */}
      {supportsSkills && (
        <Card>
          <CardHeader>
            <CardTitle>Skills</CardTitle>
            <CardDescription>Select skills to include — pinned to their current revision</CardDescription>
          </CardHeader>
          <CardContent>
            <SkillPicker selected={selectedSkills} onChange={setSelectedSkills} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
          <CardDescription>Select lifecycle resources and preset any parameter values this version should control</CardDescription>
        </CardHeader>
        <CardContent>
          <ResourcePicker selected={selectedResources} onChange={setSelectedResources} />
        </CardContent>
      </Card>

      {/* Extensions */}
      {supportsExtensions && (
        <Card>
          <CardHeader>
            <CardTitle>Extensions</CardTitle>
            <CardDescription>Select VS Code extensions — pinned to their current marketplace version</CardDescription>
          </CardHeader>
          <CardContent>
            <ExtensionPicker selected={selectedExtensions} onChange={setSelectedExtensions} />
          </CardContent>
        </Card>
      )}

      {/* Save */}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate(`/profiles/${profileId}`)}>
          Cancel
        </Button>
        <Button
          onClick={() => createVersionMutation.mutate()}
          disabled={!canSubmit || createVersionMutation.isPending}
        >
          {createVersionMutation.isPending ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...</>
          ) : (
            <><Save className="mr-2 h-4 w-4" /> Create Version</>
          )}
        </Button>
      </div>
    </div>
  );
}

function sortResourceBindings(bindings: ResourceBindingSpec[]): ResourceBindingSpec[] {
  return [...bindings]
    .map((binding) => ({
      ref: binding.ref,
      ...(binding.params ? { params: Object.fromEntries(Object.entries(binding.params).sort(([a], [b]) => a.localeCompare(b))) } : {}),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}
