// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection } from "mongodb";
import {
  resolveAgentTarget,
  type AgentTargetRequirements,
  type CodingAgentDocument,
} from "shared";

export type AgentTargetValidationFailure = {
  ok: false;
  status: 400 | 404;
  error: string;
  errorCode: string;
  activeVersions?: string[];
  supportedModels?: string[];
  unsupportedCapabilities?: string[];
};

export type AgentTargetValidationSuccess = {
  ok: true;
  agent: CodingAgentDocument;
  agentVersion: string;
  queueName: string;
  model?: string;
};

export type AgentTargetValidationResult =
  | AgentTargetValidationSuccess
  | AgentTargetValidationFailure;

export interface ValidateAgentTargetOptions {
  workerType: string;
  requestedVersion?: string;
  model?: string;
  requireModel?: boolean;
  subjectPlural?: string;
  requirements?: AgentTargetRequirements;
  strictCapabilities?: boolean;
}

/**
 * Resolve a submission target entirely from the agent registry.
 *
 * Existence, deletion, explicit availability, active version, and advertised
 * queue are always enforced. Capability flags are enforced only while the
 * deployment-controlled strict mode is enabled.
 */
export async function validateAgentTarget(
  agentCollection: Collection<CodingAgentDocument>,
  options: ValidateAgentTargetOptions,
): Promise<AgentTargetValidationResult> {
  const {
    workerType,
    requestedVersion,
    requireModel = false,
    subjectPlural = "requests",
    requirements = {},
    strictCapabilities = false,
  } = options;
  const agent = await agentCollection.findOne({ _id: workerType });
  const target = resolveAgentTarget(
    agent,
    requestedVersion,
    requirements,
    strictCapabilities,
  );

  if ("error" in target) {
    return {
      ok: false,
      status:
        target.errorCode === "agent_not_found" ||
        target.errorCode === "agent_deleted"
          ? 404
          : 400,
      ...target,
    };
  }

  let model = options.model;
  if (!agent?.supportedModels || agent.supportedModels.length === 0) {
    if (requireModel) {
      return {
        ok: false,
        status: 400,
        error: `Agent "${workerType}" does not declare any supportedModels; ${subjectPlural} cannot be created for it.`,
        errorCode: "agent_models_missing",
      };
    }
  } else {
    if (model && !agent.supportedModels.includes(model)) {
      return {
        ok: false,
        status: 400,
        error: `Invalid model "${model}" for agent "${workerType}"`,
        errorCode: "agent_model_unsupported",
        supportedModels: agent.supportedModels,
      };
    }
    model ??= agent.defaultModel;
    if (requireModel && !model) {
      return {
        ok: false,
        status: 400,
        error: `model is required for agent "${workerType}". Select one of supportedModels or set a defaultModel on the agent.`,
        errorCode: "agent_model_required",
        supportedModels: agent.supportedModels,
      };
    }
  }

  return {
    ok: true,
    agent: target.agent,
    agentVersion: target.agentVersion,
    queueName: target.queueName,
    ...(model ? { model } : {}),
  };
}

export function requestedAgentCapabilities(input: {
  reasoningEffort?: string | null;
  mcpServers?: readonly string[] | null;
  skillRevisions?: readonly string[] | null;
  extensions?: readonly string[] | null;
  resources?: readonly unknown[] | null;
}): AgentTargetRequirements {
  return {
    reasoningEffort: Boolean(input.reasoningEffort),
    mcpServers: Boolean(input.mcpServers?.length),
    skills: Boolean(input.skillRevisions?.length),
    extensions: Boolean(input.extensions?.length),
    resources: Boolean(input.resources?.length),
  };
}
