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
 *   3. GitHub Copilot SDK — a bounded pool of tool-less Copilot CLI runtimes
 *      using the `copilot-sdk` Token Manager capability (or GITHUB_TOKEN).
 *   4. GitHub Models — https://models.inference.ai.azure.com via
 *      GITHUB_MODELS_API_KEY → TokenManagerClient("github-models") → GITHUB_TOKEN
 *      (legacy compatibility fallback).
 *
 * All portal LLM modules call completePortalLlm() so provider selection and
 * lifecycle policy remain centralized.
 */
import ModelClient, {
  isUnexpected,
  type ModelClient as ModelClientType,
} from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import {
  type ChatCompletionMessage,
  TokenManagerClient,
  parseAzureAiFoundrySecret,
} from "shared";
import { postAdaptiveChatCompletion } from "./adaptive-chat-completions.js";
import {
  CopilotCredentialUnavailableError,
  getPortalCopilotClientPool,
} from "./copilot-client-pool.js";

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
    lower.includes("copilot sdk") ||
    lower.includes("copilot cli") ||
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

export function isCopilotSdkTokenAvailable(): boolean {
  return !!(process.env.GITHUB_TOKEN || process.env.TOKEN_MANAGER_URL);
}

/**
 * Returns true if any inference backend is configured.
 */
export function isLlmAvailable(): boolean {
  return (
    isFoundryConfigured() ||
    isCopilotSdkTokenAvailable() ||
    isGitHubModelsTokenAvailable()
  );
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

export type InferenceSource =
  | "azure-ai-foundry"
  | "copilot-sdk"
  | "github-models";

/**
 * How the credential was actually resolved. Useful for log lines so an
 * operator can tell at a glance whether the active LLM came from a local
 * env override, the Token Manager, or the bare GITHUB_TOKEN fallback.
 */
export type InferenceVia =
  | "azure-ai-foundry-env"
  | "azure-ai-foundry-token-manager"
  | "copilot-sdk-env"
  | "copilot-sdk-token-manager"
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

async function tryAcquireFoundryClient(): Promise<InferenceClientHandle | null> {
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

  const tmFoundry = await tryAcquireFoundryFromTokenManager();
  if (!tmFoundry) return null;

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

async function acquireGitHubModelsClient(): Promise<InferenceClientHandle> {
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
}

export interface PortalLlmCompletionRequest {
  messages: [
    { role: "system"; content: string },
    { role: "user"; content: string },
  ];
  model: string;
  temperature: number;
  max_tokens: number;
}

function inferenceErrorMessage(body: unknown, status: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return status;
}

async function completeWithRestInference(
  handle: InferenceClientHandle,
  request: PortalLlmCompletionRequest,
): Promise<string> {
  const messages: ChatCompletionMessage[] = request.messages;
  const response = await postAdaptiveChatCompletion({
    endpoint: handle.endpoint,
    model: request.model,
    messages,
    temperature: request.temperature,
    maxTokens: request.max_tokens,
    send: (body) => handle.client.path("/chat/completions").post({ body }),
  });

  if (isUnexpected(response)) {
    throw new Error(
      `LLM request failed: ${inferenceErrorMessage(response.body, response.status)}`,
    );
  }

  const content = response.body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response");
  }
  return content;
}

/**
 * Complete one Portal AI request using the configured provider chain:
 * Foundry env, Foundry Token Manager, Copilot SDK, then legacy GitHub Models.
 *
 * Provider fallback only happens while resolving a credential. Once a provider
 * begins inference, its errors are surfaced and never hidden by another backend.
 */
export async function completePortalLlm(
  request: PortalLlmCompletionRequest,
  explicitModel?: string,
): Promise<string> {
  const foundry = await tryAcquireFoundryClient();
  if (foundry) {
    const model =
      explicitModel ||
      foundry.model ||
      process.env.LLM_MODEL ||
      request.model ||
      "gpt-4.1";
    return completeWithRestInference(foundry, { ...request, model });
  }

  if (isCopilotSdkTokenAvailable()) {
    try {
      const via: InferenceVia = process.env.GITHUB_TOKEN
        ? "copilot-sdk-env"
        : "copilot-sdk-token-manager";
      const copilotModel =
        explicitModel ||
        process.env.PORTAL_COPILOT_MODEL ||
        process.env.LLM_MODEL;
      console.log(
        `[llm-token] inference provider: source=copilot-sdk via=${via} model=${copilotModel || "auto"}`,
      );
      return await getPortalCopilotClientPool().complete({
        systemPrompt: request.messages[0].content,
        userPrompt: request.messages[1].content,
        model: copilotModel,
      });
    } catch (error) {
      if (!(error instanceof CopilotCredentialUnavailableError)) {
        throw error;
      }
    }
  }

  if (isGitHubModelsTokenAvailable()) {
    let githubModels: InferenceClientHandle | null = null;
    try {
      githubModels = await acquireGitHubModelsClient();
    } catch {
      // Credential resolution failed; continue to the unified unavailable error.
    }
    if (githubModels) {
      return completeWithRestInference(githubModels, {
        ...request,
        model:
          explicitModel ||
          process.env.LLM_MODEL ||
          request.model ||
          "gpt-4.1",
      });
    }
  }

  throw new Error(
    "LLM not configured: no inference backend available. Register an Azure AI Foundry credential, a GitHub token with Copilot SDK capability, or a legacy GitHub Models key."
  );
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
  const foundry = await tryAcquireFoundryClient();
  if (foundry) return foundry;

  // Legacy REST-only helper: Copilot SDK is exposed through completePortalLlm().
  if (isGitHubModelsTokenAvailable()) {
    try {
      return await acquireGitHubModelsClient();
    } catch {
      // No usable GitHub Models token after all — drop through to the
      // unified "no backend configured" error below so the UI gets a
      // single actionable message instead of the opaque acquisition
      // failure from the token manager.
    }
  }

  throw new Error(
    "LLM not configured: no REST inference backend available. Register an Azure AI Foundry credential or a legacy GitHub Models key."
  );
}
