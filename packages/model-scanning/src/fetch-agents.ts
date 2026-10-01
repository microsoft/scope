// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { stripTrailingSlashes } from "shared/strings";
import type { AgentDefinition } from "./types.js";

/**
 * Fetch agents that declare a given model provider.
 *
 * Calls GET /api/v1/agents?modelProvider=<provider> to dynamically discover
 * which agents should receive scanned models for this provider.
 */
export async function fetchAgentsByProvider(
  apiUrl: string,
  modelProvider: string,
): Promise<AgentDefinition[]> {
  const url = `${stripTrailingSlashes(apiUrl)}/api/v1/agents?modelProvider=${encodeURIComponent(modelProvider)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown error");
    throw new Error(
      `Failed to fetch agents for provider '${modelProvider}' (HTTP ${response.status}): ${errorBody}`,
    );
  }

  const agents = (await response.json()) as AgentDefinition[];
  return agents;
}
