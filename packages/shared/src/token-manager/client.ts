// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  AcquireAccountResponse,
  AcquireKeyResponse,
  AccountType,
  KEY_CAPABILITY_ENV_VARS,
  KeyCapability,
  KeyType,
  type AcquireKeyRequest,
  type PortalAiSettings,
  PORTAL_AI_PROVIDERS,
} from "./types.js";
import { withRetry } from "../utils/retry.js";

class TokenManagerRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Client for acquiring keys from the Token Manager service.
 *
 * Workers use this to get a key before each coding session.
 * If the corresponding env var is set (e.g. GITHUB_TOKEN for 'copilot-sdk'),
 * the env var value is returned directly — no HTTP call is made.
 * This allows Docker Compose / local dev to work without the Token Manager.
 */
export class TokenManagerClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (
      baseUrl ||
      process.env.TOKEN_MANAGER_URL ||
      ""
    ).replace(/\/+$/, "");
  }

  private async portalRequest(path: string, body?: AcquireKeyRequest): Promise<unknown> {
    if (!this.baseUrl) throw new Error("Token Manager not configured: register a key at /secrets/keys/new");
    return withRetry(async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new TokenManagerRequestError(response.status, `Token Manager request failed (HTTP ${response.status})`);
      }
      const result: unknown = await response.json();
      return result;
    }, {
      maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 5000,
      isRetryable: (err) => !(err instanceof TokenManagerRequestError) || err.status === 429 || err.status >= 500,
    });
  }

  /** Portal selections never consult process env or fall back to another credential type. */
  async acquirePortalToken(request: AcquireKeyRequest): Promise<AcquireKeyResponse> {
    const data = await this.portalRequest("/api/v1/keys/acquire", request);
    if (!data || typeof data !== "object" || !("value" in data) || typeof data.value !== "string" ||
      !("keyType" in data) || typeof data.keyType !== "string") {
      throw new Error("Invalid Portal AI credential response");
    }
    const result = data as AcquireKeyResponse;
    if (result.capability !== request.capability ||
      (request.strictKeyType && request.keyType && result.keyType !== request.keyType) ||
      (request.keyId && result.keyId !== request.keyId)) {
      throw new Error("Token Manager did not honor the explicit Portal AI credential selection");
    }
    return result;
  }

  async getPortalAiSettings(): Promise<PortalAiSettings> {
    const data = await this.portalRequest("/api/v1/keys/portal-ai");
    if (!data || typeof data !== "object" || !("provider" in data) ||
      !PORTAL_AI_PROVIDERS.includes(data.provider as PortalAiSettings["provider"]) ||
      ("keyId" in data && data.keyId !== undefined && typeof data.keyId !== "string") ||
      ("model" in data && data.model !== undefined && typeof data.model !== "string")) {
      throw new Error("Invalid Portal AI settings response");
    }
    return data as PortalAiSettings;
  }

  /**
   * Acquire a key for the given capability.
   *
   * 1. If the env var fallback is set (e.g. GITHUB_TOKEN), return it directly.
   * 2. Otherwise, call `POST {baseUrl}/api/v1/keys/acquire` with `{ capability }`.
   *
   * @throws Error if no key is available or the request fails.
   */
  async acquireToken(capability: KeyCapability): Promise<string> {
    // Env var fallback — local dev / Docker Compose
    const envVar = KEY_CAPABILITY_ENV_VARS[capability];
    const envValue = process.env[envVar];
    if (envValue) {
      return envValue;
    }

    if (!this.baseUrl) {
      throw new Error(
        `No key available for capability '${capability}': ` +
          `env var '${envVar}' is not set and TOKEN_MANAGER_URL is not configured`
      );
    }

    const url = `${this.baseUrl}/api/v1/keys/acquire`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new Error(
        `Key acquisition failed for capability '${capability}' (HTTP ${response.status}): ${errorBody}`
      );
    }

    const result = (await response.json()) as AcquireKeyResponse;

    if (!result.value) {
      throw new Error(
        `Invalid key response for capability '${capability}': no value returned`
      );
    }

    return result.value;
  }

  /**
   * Acquire a key with full metadata (including keyType).
   * Use this when the caller needs to know the key type to set the correct env var.
   */
  async acquireTokenFull(capability: KeyCapability, preferredKeyType?: KeyType): Promise<AcquireKeyResponse> {
    // Env var fallback — local dev / Docker Compose
    // Check CLAUDE_CODE_OAUTH_TOKEN first for claude-code-cli capability
    if (capability === "claude-code-cli" && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return {
        value: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        keyId: "env",
        keyType: "anthropic-oauth",
        capability,
      };
    }
    const envVar = KEY_CAPABILITY_ENV_VARS[capability];
    const envValue = process.env[envVar];
    if (envValue) {
      return {
        value: envValue,
        keyId: "env",
        keyType: capability === "claude-code-cli" ? "anthropic-api-key" : "github-oauth",
        capability,
      };
    }

    if (!this.baseUrl) {
      throw new Error(
        `No key available for capability '${capability}': ` +
          `env var '${envVar}' is not set and TOKEN_MANAGER_URL is not configured`
      );
    }

    const url = `${this.baseUrl}/api/v1/keys/acquire`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability, ...(preferredKeyType ? { keyType: preferredKeyType } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new Error(
        `Key acquisition failed for capability '${capability}' (HTTP ${response.status}): ${errorBody}`
      );
    }

    const result = (await response.json()) as AcquireKeyResponse;

    if (!result.value) {
      throw new Error(
        `Invalid key response for capability '${capability}': no value returned`
      );
    }

    return result;
  }

  /**
   * Acquire account credentials for the given account type.
   *
   * 1. If env var fallbacks are set (GH_AUTH_USERNAME + GH_AUTH_PASSWORD + GH_AUTH_TOTP_SECRET),
   *    return them directly.
   * 2. Otherwise, call `POST {baseUrl}/api/v1/accounts/acquire` with `{ type }`.
   *
   * @throws Error if no account is available or the request fails.
   */
  async acquireAccount(type: AccountType): Promise<AcquireAccountResponse> {
    // Env var fallback — local dev / Docker Compose
    if (type === "github") {
      const username = process.env.GH_AUTH_USERNAME;
      const password = process.env.GH_AUTH_PASSWORD;
      const totpUri = process.env.GH_AUTH_TOTP_SECRET;
      if (username && password && totpUri) {
        return { accountId: "env", type, username, password, totpUri };
      }
    }

    if (!this.baseUrl) {
      throw new Error(
        `No account available for type '${type}': ` +
          `env vars are not set and TOKEN_MANAGER_URL is not configured`
      );
    }

    const url = `${this.baseUrl}/api/v1/accounts/acquire`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new Error(
        `Account acquisition failed for type '${type}' (HTTP ${response.status}): ${errorBody}`
      );
    }

    const result = (await response.json()) as AcquireAccountResponse;

    if (!result.username || !result.password || !result.totpUri) {
      throw new Error(
        `Invalid account response for type '${type}': missing credentials`
      );
    }

    return result;
  }
}
