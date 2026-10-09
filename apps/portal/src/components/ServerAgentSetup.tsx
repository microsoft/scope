// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConfigureServerAgent, ServerAgentStatus, ServerWorkerType } from "shared/server";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import { configureServerAgent, getServerStatus } from "@/lib/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";

/** Props for the local-agent setup dialog's presentational view. */
export interface ServerAgentSetupViewProps {
  agents: ServerAgentStatus[];
  busy?: boolean;
  error?: string;
  onConfigure: (workerType: ServerWorkerType, input: ConfigureServerAgent) => void;
}

interface AgentSetupCardProps {
  agent: ServerAgentStatus;
  busy: boolean;
  onConfigure: ServerAgentSetupViewProps["onConfigure"];
}

function configureInput(
  agent: ServerAgentStatus,
  consent: boolean,
  executable: string,
): ConfigureServerAgent {
  if (agent.enabled) return { enabled: false };
  if (agent.runtime !== "host") return { enabled: true };

  const trimmedExecutable = executable.trim();
  return {
    enabled: true,
    consent,
    ...(trimmedExecutable ? { executable: trimmedExecutable } : {}),
  };
}

function AgentSetupCard({ agent, busy, onConfigure }: AgentSetupCardProps) {
  const [executable, setExecutable] = useState(agent.executable ?? "");
  const [consent, setConsent] = useState(false);
  const host = agent.runtime === "host";
  const status = agent.error ? "Failed" : agent.available ? "Ready" : agent.enabled ? "Starting" : "Stopped";
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={agent.label}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{agent.label}</h3>
        <Badge variant={agent.available ? "default" : "secondary"}>{status}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {host ? "Uses the installed CLI and its current login." : "Builds and runs the Docker worker when enabled."}
        {agent.version ? ` Version: ${agent.version}.` : ""}
      </p>
      {host && (
        <>
          <Label htmlFor={`executable-${agent.workerType}`}>CLI executable</Label>
          <Input
            id={`executable-${agent.workerType}`}
            value={executable}
            placeholder="Detect from PATH"
            disabled={busy || agent.enabled}
            onChange={event => setExecutable(event.target.value)}
          />
          {!agent.enabled && (
            <div className="flex items-start gap-2">
              <Checkbox
                id={`consent-${agent.workerType}`}
                checked={consent}
                onCheckedChange={value => setConsent(value === true)}
                disabled={busy}
              />
              <Label htmlFor={`consent-${agent.workerType}`} className="text-sm leading-relaxed">
                Allow this agent to run unattended on my computer. Its workspace is not a sandbox.
              </Label>
            </div>
          )}
        </>
      )}
      {agent.error && <p role="alert" className="text-sm text-destructive">{agent.error}</p>}
      <Button
        variant={agent.enabled ? "outline" : "default"}
        disabled={busy || (!agent.enabled && host && !consent)}
        onClick={() => onConfigure(agent.workerType, configureInput(agent, consent, executable))}
      >
        {agent.enabled ? "Stop" : "Enable"} {agent.label}
      </Button>
    </section>
  );
}

/** Presentational dialog for enabling/disabling local host or Docker workers. */
export function ServerAgentSetupView({ agents, busy = false, error, onConfigure }: ServerAgentSetupViewProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline"><Settings2 className="mr-2 h-4 w-4" />Set up local agents</Button>
      </DialogTrigger>
      <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Local agents</DialogTitle>
          <DialogDescription>
            Choose host or Docker workers. Only selected Docker workers need to be built.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {agents.map(agent => (
            <AgentSetupCard
              key={`${agent.workerType}:${agent.enabled}:${agent.executable ?? ""}`}
              agent={agent}
              busy={busy}
              onConfigure={onConfigure}
            />
          ))}
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Done</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Query-backed entry point shown on the Agents page when a local launcher is present.
 *
 * Server setup mutates the scheduler-visible agent catalog, so successful status
 * reads and setup changes invalidate the ordinary agent queries as well.
 */
export function ServerAgentSetup() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["local-server"],
    queryFn: getServerStatus,
    retry: 1,
    refetchInterval: query => query.state.data?.enabled ? 3000 : false,
  });
  useEffect(() => {
    if (status.data?.enabled) {
      void client.invalidateQueries({ queryKey: ["agents"] });
      void client.invalidateQueries({ queryKey: ["agent"] });
    }
  }, [status.data, client]);
  const configure = useMutation({
    mutationFn: ({ workerType, input }: { workerType: ServerWorkerType; input: ConfigureServerAgent }) =>
      configureServerAgent(workerType, input),
    onSuccess: data => {
      client.setQueryData(["local-server"], data);
      void client.invalidateQueries({ queryKey: ["agents"] });
      void client.invalidateQueries({ queryKey: ["agent"] });
      toast.success("Agent configuration updated");
    },
  });
  if (status.isError) {
    return (
      <Button variant="outline" title={status.error.message} onClick={() => void status.refetch()}>
        Retry local agent setup
      </Button>
    );
  }
  if (!status.data?.enabled) return null;
  return (
    <ServerAgentSetupView
      agents={status.data.agents}
      busy={configure.isPending}
      error={configure.error?.message}
      onConfigure={(workerType, input) => configure.mutate({ workerType, input })}
    />
  );
}
