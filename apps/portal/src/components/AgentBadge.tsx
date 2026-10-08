// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CodingAgent } from "@/types";

const AGENT_CATALOG_QUERY_KEY = ["agents", "include-deleted"] as const;

export function useAgentCatalog(enabled = true): {
  agents: CodingAgent[];
  agentById: ReadonlyMap<string, CodingAgent>;
  isLoading: boolean;
} {
  const { data: agents = [], isLoading } = useQuery({
    queryKey: AGENT_CATALOG_QUERY_KEY,
    queryFn: () => api.listAgents({ includeDeleted: true }),
    enabled,
    staleTime: 60_000,
  });
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent._id, agent])),
    [agents],
  );
  return { agents, agentById, isLoading };
}

export function agentDisplayName(
  agentId: string | undefined | null,
  agentById: ReadonlyMap<string, CodingAgent>,
): string {
  return (agentId && agentById.get(agentId)?.name) || "Unknown agent";
}

interface AgentBadgeProps {
  agentId?: string | null;
  agent?: CodingAgent;
  version?: string;
  variant?: "plain" | "badge";
  triggerLink?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * User-facing agent reference with hover metadata and detail navigation.
 *
 * The registry name is always primary UI. The internal id remains available in
 * the hover card and in the Agents technical views.
 */
export function AgentBadge({
  agentId,
  agent: preloadedAgent,
  version,
  variant = "plain",
  triggerLink = true,
  className,
  children,
}: AgentBadgeProps) {
  const { agentById, isLoading } = useAgentCatalog(!preloadedAgent);
  const agent = preloadedAgent ?? (agentId ? agentById.get(agentId) : undefined);
  const label = agent?.name ?? (isLoading ? "Loading agent…" : "Unknown agent");
  const canNavigate = !!agentId && !!agent;

  const content = children ?? (
    variant === "badge" ? (
      <Badge variant="outline" className="max-w-full text-xs">
        <span className="truncate">{label}</span>
      </Badge>
    ) : (
      <span className="truncate">{label}</span>
    )
  );

  const trigger = canNavigate && triggerLink ? (
    <Link
      to={`/agents/${encodeURIComponent(agentId)}`}
      className={cn("inline-flex max-w-full hover:underline", className)}
      onClick={(event) => event.stopPropagation()}
    >
      {content}
    </Link>
  ) : (
    <span className={cn("inline-flex max-w-full", className)}>{content}</span>
  );

  if (!agentId) return trigger;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipPrimitive.Portal>
          <TooltipContent side="top" collisionPadding={8} className="max-w-sm">
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium">{label}</span>
                {agent?.deletedAt && <Badge variant="secondary">Deleted</Badge>}
              </div>
              <div className="font-mono text-muted-foreground">{agentId}</div>
              {version && (
                <div className="text-muted-foreground">
                  Version <span className="font-mono">{version}</span>
                </div>
              )}
              {canNavigate && (
                <Button
                  asChild
                  size="sm"
                  variant="secondary"
                  className="mt-0.5 h-7 w-full justify-center gap-1"
                >
                  <Link
                    to={`/agents/${encodeURIComponent(agentId)}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    View agent
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
            </div>
          </TooltipContent>
        </TooltipPrimitive.Portal>
      </Tooltip>
    </TooltipProvider>
  );
}
