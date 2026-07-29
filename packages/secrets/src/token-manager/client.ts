// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  AcquireAccountResponse,
  AcquireKeyResponse,
  AccountType,
  KEY_CAPABILITY_ENV_VARS,
  KeyCapability,
  KeyType,
} from "./types.js";

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
