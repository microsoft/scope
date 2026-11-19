// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ScannedModel, ScanResult, ModelCapabilities } from "model-scanning";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

/**
 * Extract structured capabilities from the Copilot API `capabilities.supports` object.
 */
function extractCopilotCapabilities(
  supports: Record<string, unknown> | undefined,
): ModelCapabilities | undefined {
  if (!supports || typeof supports !== "object") return undefined;

  const capabilities: ModelCapabilities = {};

  if (Array.isArray(supports.reasoning_effort)) {
    capabilities.reasoningEffort = supports.reasoning_effort.filter(
      (v: unknown) => typeof v === "string",
    );
  }
  if (typeof supports.tool_calls === "boolean") {
    capabilities.toolCalls = supports.tool_calls;
  }
  if (typeof supports.vision === "boolean") {
    capabilities.vision = supports.vision;
  }
  if (typeof supports.streaming === "boolean") {
    capabilities.streaming = supports.streaming;
  }
  if (typeof supports.adaptive_thinking === "boolean") {
    capabilities.adaptiveThinking = supports.adaptive_thinking;
  }
  if (typeof supports.max_thinking_budget === "number") {
    capabilities.maxThinkingBudget = supports.max_thinking_budget;
  }

  // Only return if at least one field was populated
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

/**
 * Scan models available from the GitHub Copilot API.
 *
 * Calls GET https://api.githubcopilot.com/models and parses the response.
 * Permissive: only validates the `id` field on each model, ignores unknown fields.
 *
 * @see https://aider.chat/docs/llms/github.html
 */
export async function scanCopilotModels(
  token: string | null,
  fetchFn: FetchFn = (input, init) => fetch(input, init),
): Promise<ScanResult> {
  // With CAPI HMAC the gateway strips Authorization and sets the integration
  // ID, so `token` is null and these headers are only the token-based defaults.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "vscode-chat",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchFn(COPILOT_MODELS_URL, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown error");
    throw new Error(
      `Copilot models API returned HTTP ${response.status}: ${errorBody}`,
    );
  }

  const body = await response.json();

  // Permissive parsing: expect { data: [...] } but handle variations
  const rawModels = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body)
      ? body
      : [];

  const models: ScannedModel[] = rawModels
    .filter(
      (m: Record<string, unknown>) => m && typeof m.id === "string" && m.id,
    )
    .map((m: Record<string, unknown>) => {
      const caps = m.capabilities as Record<string, unknown> | undefined;
      const supports = caps?.supports as Record<string, unknown> | undefined;
      const capabilities = extractCopilotCapabilities(supports);

      return {
        id: m.id as string,
        // Extract availability/EOL dates if the API provides them
        ...(m.created_at
          ? { providerAvailableFrom: new Date(m.created_at as string) }
          : {}),
        ...(m.deprecation_date || m.end_of_life
          ? {
              providerEndOfLife: new Date(
                (m.deprecation_date || m.end_of_life) as string,
              ),
            }
          : {}),
        // Keep a subset of useful metadata
        ...(m.name || m.version
          ? {
              metadata: {
                ...(m.name ? { name: m.name } : {}),
                ...(m.version ? { version: m.version } : {}),
              },
            }
          : {}),
        ...(capabilities ? { capabilities } : {}),
      };
    });

  return {
    provider: "github-copilot",
    models,
    scannedAt: new Date(),
  };
}
