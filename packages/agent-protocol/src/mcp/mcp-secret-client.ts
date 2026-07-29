// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { McpServerHeader } from '@scope/core';

/**
 * Thrown when the Token Manager is configured but unreachable (network failure).
 * Distinct from HTTP errors so callers can return 503 rather than 500.
 */
export class McpSecretUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Secret storage unavailable: Token Manager is unreachable (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = 'McpSecretUnavailableError';
  }
}

/** Metadata returned from list endpoint — no value ever included */
export interface McpSecretListItem {
  id: string;
  mcpId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Resolved secrets shaped for stdio servers */
export interface McpSecretResolvedStdio {
  env: Record<string, string>;
}

/** Resolved secrets shaped for sse/http servers */
export interface McpSecretResolvedHttp {
  headers: McpServerHeader[];
}

export type McpSecretResolved = McpSecretResolvedStdio | McpSecretResolvedHttp;

/**
 * Client for managing MCP server secrets via the Token Manager service.
 *
 * Secrets are stored encrypted in Azure Key Vault by the Token Manager.
 * The API uses this client directly (not via proxy) for server-side calls:
 *   - resolveSecrets(): called when registering a server with the MCP gateway
 *   - deleteAllSecrets(): called on server delete
 *
 * Portal/CLI flows go through the API proxy — this client is internal only.
 */
export class McpSecretClient {
  private readonly tokenManagerUrl: string;

  constructor(tokenManagerUrl: string) {
    this.tokenManagerUrl = tokenManagerUrl.replace(/\/+$/, '');
  }

  private async fetchOrThrow(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (cause) {
      throw new McpSecretUnavailableError(cause);
    }
  }

  /**
   * Upsert a secret (create or overwrite by name).
   * Returns metadata only — value is never returned.
   */
  async storeSecret(mcpId: string, name: string, value: string): Promise<McpSecretListItem> {
    const url = `${this.tokenManagerUrl}/api/v1/mcp/servers/${encodeURIComponent(mcpId)}/secrets`;
    const res = await this.fetchOrThrow(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value }),
    });
    if (!res.ok) {
      throw new Error(`[McpSecretClient] POST ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<McpSecretListItem>;
  }

  /**
   * Store all secrets from an env map (for stdio servers).
   */
  async storeEnv(mcpId: string, env: Record<string, string>): Promise<McpSecretListItem[]> {
    const results: McpSecretListItem[] = [];
    for (const [name, value] of Object.entries(env)) {
      results.push(await this.storeSecret(mcpId, name, value));
    }
    return results;
  }

  /**
   * Store all secrets from a headers array (for sse/http servers).
   */
  async storeHeaders(mcpId: string, headers: McpServerHeader[]): Promise<McpSecretListItem[]> {
    const results: McpSecretListItem[] = [];
    for (const { name, value } of headers) {
      results.push(await this.storeSecret(mcpId, name, value));
    }
    return results;
  }

  /**
   * List secret metadata (names, ids — no values) for an MCP server.
   */
  async listSecrets(mcpId: string): Promise<McpSecretListItem[]> {
    const url = `${this.tokenManagerUrl}/api/v1/mcp/servers/${encodeURIComponent(mcpId)}/secrets`;
    const res = await this.fetchOrThrow(url);
    if (!res.ok) {
      throw new Error(`[McpSecretClient] GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<McpSecretListItem[]>;
  }

  /**
   * Resolve all secrets for an MCP server to their actual plaintext values.
   * Returns transport-aware shape: env map for stdio, headers array for sse/http.
   * Internal use only — called by the API before registering with the MCP gateway.
   */
  async resolveSecrets(mcpId: string): Promise<McpSecretResolved> {
    const url = `${this.tokenManagerUrl}/api/v1/mcp/servers/${encodeURIComponent(mcpId)}/secrets/resolve`;
    const res = await this.fetchOrThrow(url);
    if (!res.ok) {
      throw new Error(`[McpSecretClient] GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<McpSecretResolved>;
  }

  /**
   * Delete a single secret by name.
   */
  async deleteSecret(mcpId: string, name: string): Promise<void> {
    const url = `${this.tokenManagerUrl}/api/v1/mcp/servers/${encodeURIComponent(mcpId)}/secrets/${encodeURIComponent(name)}`;
    const res = await this.fetchOrThrow(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`[McpSecretClient] DELETE ${url} failed: ${res.status} ${res.statusText}`);
    }
  }

  /**
   * Delete all secrets for an MCP server (best-effort, called on server delete).
   */
  async deleteAllSecrets(mcpId: string): Promise<void> {
    const items = await this.listSecrets(mcpId).catch(() => [] as McpSecretListItem[]);
    await Promise.allSettled(items.map((item) => this.deleteSecret(mcpId, item.name)));
  }
}
