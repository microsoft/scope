// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AgentDefinition } from "./types.js";
import { serviceAuthHeaders } from "./service-auth.js";

/**
 * Create or update an agent definition via the API.
 *
 * Calls POST /api/v1/agents which performs an idempotent upsert:
 * - Creates the agent if it doesn't exist
 * - Updates and un-deletes if it does exist
 */
export async function upsertAgent(
  apiUrl: string,
  agent: AgentDefinition,
): Promise<void> {
  const url = `${apiUrl.replace(/\/+$/, "")}/api/v1/agents`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...serviceAuthHeaders() },
    body: JSON.stringify(agent),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown error");
    throw new Error(
      `Agent upsert failed for '${agent._id}' (HTTP ${response.status}): ${errorBody}`,
    );
  }

  console.log(`Agent '${agent._id}' upserted successfully.`);
}
