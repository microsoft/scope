// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared helper for acquiring an inference client for the portal AI features.
 *
 * Endpoint resolution priority:
 *   1. Azure AI Foundry env vars — AZURE_AI_INFERENCE_ENDPOINT +
 *      AZURE_AI_INFERENCE_API_KEY (preferred for local dev; explicit override).
 *   2. Azure AI Foundry via the Token Manager — TOKEN_MANAGER_URL with at
 *      least one registered `azure-ai-foundry` key (preferred for prod;
 *      round-robins across registered keys).
 *   3. GitHub Models — https://models.inference.ai.azure.com via
 *      GITHUB_MODELS_API_KEY → TokenManagerClient("github-models") → GITHUB_TOKEN
 *      (fallback; slow public endpoint, fine for local dev only).
 *
 * All three portal LLM modules (llm.ts, prompt-feature-llm.ts,
 * task-prompt-llm.ts) call acquireInferenceClient() instead of constructing
 * a ModelClient inline so the endpoint can be swapped in one place.
 */
import ModelClient, { type ModelClient as ModelClientType } from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import {
  TokenManagerClient,
  parseAzureAiFoundrySecret,
} from "shared";

const GITHUB_MODELS_ENDPOINT = "https://models.inference.ai.azure.com";

let tokenManagerClient: TokenManagerClient | null = null;

function getTokenManagerClient(): TokenManagerClient | null {
  if (tokenManagerClient) return tokenManagerClient;
  const url = process.env.TOKEN_MANAGER_URL;
  if (!url) return null;
  tokenManagerClient = new TokenManagerClient(url);
  return tokenManagerClient;
}

function isFoundryConfigured(): boolean {
  return !!(process.env.AZURE_AI_INFERENCE_ENDPOINT && process.env.AZURE_AI_INFERENCE_API_KEY);
}

/**
 * Normalize the Azure AI Foundry endpoint URL.
 *
 * The inference data plane on an Azure AI Services / Foundry resource sits
 * at `<resource>.services.ai.azure.com/models` — without the `/models`
 * suffix every `chat/completions` call returns a 404. This is a very common
 * configuration footgun (the Azure portal shows the resource URL without
 * the path), so we auto-append it for `services.ai.azure.com` hosts that
 * have no path and warn loudly. For any other host or any URL that already
 * has a path we pass through untouched.
 */
function normalizeFoundryEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    const hasPath = url.pathname && url.pathname !== "/";
    if (!hasPath && url.hostname.endsWith(".services.ai.azure.com")) {
      const fixed = `${trimmed}/models`;
      console.warn(
        `[llm-token] AZURE_AI_INFERENCE_ENDPOINT='${trimmed}' is missing the /models path. Auto-correcting to '${fixed}'. Update your .env.local to silence this warning.`
      );
      return fixed;
    }
  } catch {
    // Let the SDK surface the malformed-URL error downstream.
  }
  return trimmed;
}

/**
 * Returns true when an error thrown from a portal LLM call is one that
 * should be surfaced to the client as a 503 (LLM-unavailable / config
 * problem / inference-time failure) rather than bubbled to the generic
 * error handler as a 500. The route handlers all share this set of
 * patterns; consolidating the check here keeps them aligned as new
 * inference errors get added.
 */
export function isInferenceError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const lower = err.message.toLowerCase();
  return (
    err.message.includes("not configured") ||
    lower.includes("llm request failed") ||
    lower.includes("resource not found") ||
    lower.includes("authentication failed")
  );
}

/**
 * Returns true if a GitHub Models token is available from any source:
 * - GITHUB_MODELS_API_KEY env var
 * - TOKEN_MANAGER_URL (token manager with registered github-models tokens)
 * - GITHUB_TOKEN env var (generic fallback)
 */
export function isGitHubModelsTokenAvailable(): boolean {
  return !!(
    process.env.GITHUB_MODELS_API_KEY ||
    process.env.TOKEN_MANAGER_URL ||
    process.env.GITHUB_TOKEN
  );
}

/**
 * Returns true if any inference backend (Foundry or GitHub Models) is configured.
 */
export function isLlmAvailable(): boolean {
  return isFoundryConfigured() || isGitHubModelsTokenAvailable();
}

/**
 * Acquire a GitHub Models API token.
 *
 * Tries (in order):
 *   1. GITHUB_MODELS_API_KEY env var
 *   2. Token Manager: registered `github-models` key
 *   3. GITHUB_TOKEN env var (bare fallback)
 *
 * If the Token Manager is configured but has no `github-models` key
 * registered (HTTP 404), we suppress that and try the bare GITHUB_TOKEN
 * fallback instead of propagating the cryptic acquisition error.
 *
 * @throws Error with a user-actionable message when no source is available.
 */
export async function acquireGitHubModelsToken(): Promise<string> {
  // 1. Explicit env var override
  const explicit = process.env.GITHUB_MODELS_API_KEY;
  if (explicit) return explicit;

  // 2. Token Manager — but suppress acquisition errors so we can fall
  // through to GITHUB_TOKEN instead of propagating an opaque 404.
  const client = getTokenManagerClient();
  if (client) {
    try {
      return await client.acquireToken("github-models");
    } catch {
      // No github-models key registered (or token manager unreachable);
      // fall through to bare GITHUB_TOKEN below.
    }
  }

  // 3. Bare GITHUB_TOKEN fallback
  const fallback = process.env.GITHUB_TOKEN;
  if (fallback) return fallback;

  throw new Error(
    "No GitHub Models token available: register a `github-models` key at /secrets/keys/new, or set GITHUB_MODELS_API_KEY / GITHUB_TOKEN"
  );
}

export type InferenceSource = "azure-ai-foundry" | "github-models";

/**
 * How the credential was actually resolved. Useful for log lines so an
 * operator can tell at a glance whether the active LLM came from a local
 * env override, the Token Manager, or the bare GITHUB_TOKEN fallback.
 */
export type InferenceVia =
  | "azure-ai-foundry-env"
  | "azure-ai-foundry-token-manager"
  | "github-models-env"
  | "github-models-token-manager"
  | "github-token";

export interface InferenceClientHandle {
  client: ModelClientType;
  endpoint: string;
  source: InferenceSource;
  via: InferenceVia;
  /**
   * When the source is "azure-ai-foundry" via the Token Manager, the
   * registered secret can override the default model name. Callers should
   * honour this when present (and fall back to `process.env.LLM_MODEL`).
   */
  model?: string;
}

function logInferenceAcquired(handle: InferenceClientHandle): void {
  const model = handle.model || process.env.LLM_MODEL || "gpt-4.1";
  console.log(
    `[llm-token] inference provider: source=${handle.source} via=${handle.via} endpoint=${handle.endpoint} model=${model}`,
  );
}

/**
 * Try to acquire a Foundry credential from the Token Manager.
 *
 * Returns null when no token-manager is configured, when no key is
 * registered for the capability, when the request fails, or when the
 * registered secret is malformed.
 *
 * Note: when only AZURE_AI_INFERENCE_API_KEY is set (without the matching
 * endpoint), TokenManagerClient's env-var shortcut returns the bare key,
 * which parseAzureAiFoundrySecret rejects as malformed — so we fall
 * through to the next backend. The both-vars-set case is already handled
 * in acquireInferenceClient before this is called.
 */
async function tryAcquireFoundryFromTokenManager(): Promise<{
  endpoint: string;
  apiKey: string;
  model?: string;
} | null> {
  const client = getTokenManagerClient();
  if (!client) return null;

  try {
    const raw = await client.acquireToken("azure-ai-inference");
    return parseAzureAiFoundrySecret(raw);
  } catch {
    return null;
  }
}

/**
 * Build a ModelClient for the configured inference backend.
 *
 * Tries Azure AI Foundry first (env vars, then Token Manager), then falls
 * back to GitHub Models. See module docstring for the full priority order.
 *
 * @throws Error if no inference backend is configured.
 */
export async function acquireInferenceClient(): Promise<InferenceClientHandle> {
  // 1. Azure AI Foundry via env vars — explicit override, preferred locally.
  if (isFoundryConfigured()) {
    const endpoint = normalizeFoundryEndpoint(process.env.AZURE_AI_INFERENCE_ENDPOINT!);
    const apiKey = process.env.AZURE_AI_INFERENCE_API_KEY!;
    const model = process.env.LLM_MODEL || "gpt-4.1";
    const handle: InferenceClientHandle = {
      client: ModelClient(endpoint, new AzureKeyCredential(apiKey)),
      endpoint,
      source: "azure-ai-foundry",
      via: "azure-ai-foundry-env",
      model,
    };
    logInferenceAcquired(handle);
    return handle;
  }

  // 2. Azure AI Foundry via the Token Manager — preferred in production.
  const tmFoundry = await tryAcquireFoundryFromTokenManager();
  if (tmFoundry) {
    const model = tmFoundry.model || process.env.LLM_MODEL || "gpt-4.1";
    const handle: InferenceClientHandle = {
      client: ModelClient(tmFoundry.endpoint, new AzureKeyCredential(tmFoundry.apiKey)),
      endpoint: tmFoundry.endpoint,
      source: "azure-ai-foundry",
      via: "azure-ai-foundry-token-manager",
      model,
    };
    logInferenceAcquired(handle);
    return handle;
  }

  // 3. GitHub Models — public fallback (slow; fine for local dev).
  if (isGitHubModelsTokenAvailable()) {
    try {
      const token = await acquireGitHubModelsToken();
      const via: InferenceVia = process.env.GITHUB_MODELS_API_KEY
        ? "github-models-env"
        : process.env.TOKEN_MANAGER_URL
          ? "github-models-token-manager"
          : "github-token";
      const handle: InferenceClientHandle = {
        client: ModelClient(GITHUB_MODELS_ENDPOINT, new AzureKeyCredential(token)),
        endpoint: GITHUB_MODELS_ENDPOINT,
        source: "github-models",
        via,
      };
      logInferenceAcquired(handle);
      return handle;
    } catch {
      // No usable GitHub Models token after all — drop through to the
      // unified "no backend configured" error below so the UI gets a
      // single actionable message instead of the opaque acquisition
      // failure from the token manager.
    }
  }

  throw new Error(
    "LLM not configured: no inference backend available. Please register a new secret key for GitHub Model or Azure Foundry."
  );
}
