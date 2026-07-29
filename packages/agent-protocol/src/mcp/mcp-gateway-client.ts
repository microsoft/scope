// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { McpServerConfig } from '@scope/core';

/** Maps DB transport type to MCPJungle transport name */
const TRANSPORT_MAP: Record<string, string> = {
  http: 'streamable_http',
  sse: 'sse',
  stdio: 'stdio',
};

/**
 * HTTP client for the MCPJungle gateway sidecar.
 *
 * MCPJungle aggregates stdio and remote HTTP MCP servers behind a single
 * streamable HTTP endpoint. Workers register servers per-message and route
 * all MCP traffic through the gateway endpoint.
 *
 * Reads MCP_GATEWAY_URL from env. Use McpGatewayClient.isEnabled() to check
 * if the gateway sidecar is configured before creating an instance.
 */
export class McpGatewayClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env.MCP_GATEWAY_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  }

  /** The streamable HTTP endpoint to pass to ACP sessions */
  get mcpEndpoint(): string {
    return `${this.baseUrl}/mcp`;
  }

  /** Returns true if MCP_GATEWAY_URL is set in the environment */
  static isEnabled(): boolean {
    return !!process.env.MCP_GATEWAY_URL;
  }

  /** List currently registered server names */
  async listServers(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/v0/servers`);
    if (!res.ok) {
      throw new Error(`[McpGatewayClient] GET /api/v0/servers failed: ${res.status}`);
    }
    const data = await res.json() as Array<{ name: string }>;
    return data.map((s) => s.name);
  }

  /** Register a server with the gateway (force=true is idempotent) */
  async registerServer(config: McpServerConfig): Promise<void> {
    const transport = TRANSPORT_MAP[config.type] ?? config.type;
    // Use slug (gateway-safe identifier) as the name — display name may contain spaces
    const body: Record<string, unknown> = { name: config.slug, transport };

    if (config.type === 'stdio') {
      body.command = config.command;
      body.args = config.args ?? [];
      if (config.env && Object.keys(config.env).length > 0) body.env = config.env;
      body.session_mode = config.sessionMode ?? 'stateful';
    } else {
      body.url = config.url;
      body.session_mode = config.sessionMode ?? 'stateless';
      if (config.headers && config.headers.length > 0) {
        body.headers = Object.fromEntries(config.headers.map((h) => [h.name, h.value]));
      }
    }

    const res = await fetch(`${this.baseUrl}/api/v0/servers?force=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[McpGatewayClient] POST /api/v0/servers failed: ${res.status} ${text}`);
    }
  }

  /** Deregister a server by name (404 is treated as success) */
  async deregisterServer(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v0/servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`[McpGatewayClient] DELETE /api/v0/servers/${name} failed: ${res.status}`);
    }
  }

  /** Deregister all currently registered servers (crash recovery) */
  async purgeAll(): Promise<void> {
    const names = await this.listServers();
    await Promise.all(names.map((name) => this.deregisterServer(name)));
  }
}
