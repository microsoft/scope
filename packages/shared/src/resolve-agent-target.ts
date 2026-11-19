// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AgentCapabilities, AgentVersion, CodingAgentDocument } from "./types/types.js";
import { resolveAgentVersion } from "./resolve-agent-version.js";

export type AgentCapability = keyof AgentCapabilities;

export interface AgentTargetRequirements {
  reasoningEffort?: boolean;
  mcpServers?: boolean;
  skills?: boolean;
  extensions?: boolean;
  resources?: boolean;
}

export type AgentTargetErrorCode =
  | "agent_not_found"
  | "agent_deleted"
  | "agent_unavailable"
  | "agent_version_unavailable"
  | "agent_queue_missing"
  | "agent_capability_unsupported";

export interface ResolvedAgentTarget {
  agent: CodingAgentDocument;
  version: AgentVersion;
  agentVersion: string;
  queueName: string;
}

export interface AgentTargetError {
  error: string;
  errorCode: AgentTargetErrorCode;
  activeVersions?: string[];
  unsupportedCapabilities?: AgentCapability[];
}

const REQUIREMENT_CAPABILITIES: ReadonlyArray<{
  requirement: keyof AgentTargetRequirements;
  capability: AgentCapability;
}> = [
  { requirement: "reasoningEffort", capability: "supportsReasoningEffort" },
  { requirement: "mcpServers", capability: "supportsMcpServers" },
  { requirement: "skills", capability: "supportsSkills" },
  { requirement: "extensions", capability: "supportsExtensions" },
  { requirement: "resources", capability: "supportsResources" },
];

export function requiredAgentCapabilities(
  requirements: AgentTargetRequirements,
): AgentCapability[] {
  return REQUIREMENT_CAPABILITIES
    .filter(({ requirement }) => requirements[requirement] === true)
    .map(({ capability }) => capability);
}

/**
 * Resolve a runnable registry target.
 *
 * Registration, explicit availability, an active version, and that version's
 * advertised queue are always required. Capability compatibility is optionally
 * strict to support a deployment-controlled rollout; omitted flags always mean
 * unsupported when strict enforcement is enabled.
 */
export function resolveAgentTarget(
  agent: CodingAgentDocument | null | undefined,
  requestedVersion: string | undefined,
  requirements: AgentTargetRequirements = {},
  strictCapabilities = false,
): ResolvedAgentTarget | AgentTargetError {
  if (!agent) {
    return { error: "Agent is not registered", errorCode: "agent_not_found" };
  }
  if (agent.deletedAt) {
    return {
      error: `Agent "${agent._id}" is deleted`,
      errorCode: "agent_deleted",
    };
  }
  if (agent.available !== true) {
    return {
      error: `Agent "${agent._id}" is not available for new submissions`,
      errorCode: "agent_unavailable",
    };
  }

  const versionResult = resolveAgentVersion(agent.versions, requestedVersion);
  if ("error" in versionResult) {
    return {
      error: `${versionResult.error} for agent "${agent._id}"`,
      errorCode: "agent_version_unavailable",
      activeVersions: versionResult.activeVersions,
    };
  }

  const version = (agent.versions ?? []).find(
    (candidate) =>
      candidate.status === "active" &&
      candidate.agentVersion === versionResult.agentVersion,
  );
  const queueName = version?.queueName?.trim();
  if (!version || !queueName) {
    return {
      error: `Active agent version "${versionResult.agentVersion}" for agent "${agent._id}" does not advertise a queueName`,
      errorCode: "agent_queue_missing",
      activeVersions: (agent.versions ?? [])
        .filter((candidate) => candidate.status === "active")
        .map((candidate) => candidate.agentVersion),
    };
  }

  if (strictCapabilities) {
    const unsupportedCapabilities = requiredAgentCapabilities(requirements).filter(
      (capability) => agent.capabilities?.[capability] !== true,
    );
    if (unsupportedCapabilities.length > 0) {
      return {
        error: `Agent "${agent._id}" does not support required capabilities: ${unsupportedCapabilities.join(", ")}`,
        errorCode: "agent_capability_unsupported",
        unsupportedCapabilities,
      };
    }
  }

  return {
    agent,
    version,
    agentVersion: version.agentVersion,
    queueName,
  };
}
