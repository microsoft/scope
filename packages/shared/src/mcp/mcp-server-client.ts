// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { McpServerConfig, McpServerDocument } from '../types/mcp.js';
import { stripTrailingSlashes } from '../utils/strings.js';

/**
 * Client for resolving MCP server slugs via the Scope REST API.
 *
 * Used by queue processors at message-processing time to resolve
 * MCP server slugs stored on RequestDocuments into full McpServerConfig
 * objects that can be passed to coding agent workers.
 */
export class McpServerClient {
  private readonly apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = stripTrailingSlashes(apiUrl);
  }

  /**
   * Resolve an array of MCP server slugs to their full configurations.
   * Fetches each server from the API (scoped to the run's project) and maps to McpServerConfig.
   *
   * @throws Error if any slug cannot be resolved (404 or HTTP error)
   */
  async resolveServers(projectId: string, slugs: string[]): Promise<McpServerConfig[]> {
    if (slugs.length === 0) return [];

    const configs: McpServerConfig[] = [];

    for (const slug of slugs) {
      const url = `${this.apiUrl}/api/v1/mcp/servers/${encodeURIComponent(slug)}?projectId=${encodeURIComponent(projectId)}`;
      const res = await fetch(url);

      if (res.status === 404) {
        throw new Error(`MCP server '${slug}' not found via API`);
      }
      if (!res.ok) {
        throw new Error(`[McpServerClient] GET ${url} failed: ${res.status} ${res.statusText}`);
      }

      const data = await res.json() as McpServerDocument;
      configs.push(mapToMcpServerConfig(data));
    }

    return configs;
  }
}

/**
 * Map an API response (McpServerDocument) to a McpServerConfig,
 * stripping DB metadata (createdAt, updatedAt, deletedAt).
 *
 * The gateway identity is the human `slug` (used to name the server and prefix
 * tools as `{slug}__{tool}`), NOT the internal UUID `_id`. Falls back to `_id`
 * for pre-migration rows whose `_id` is still the slug.
 */
function mapToMcpServerConfig(data: McpServerDocument): McpServerConfig {
  return {
    type: data.type,
    slug: data.slug ?? data._id,
    name: data.name,
    ...(data.url ? { url: data.url } : {}),
    ...(data.command ? { command: data.command } : {}),
    ...(data.args && data.args.length > 0 ? { args: data.args } : {}),
    ...(data.env && Object.keys(data.env).length > 0 ? { env: data.env } : {}),
    ...(data.headers && data.headers.length > 0 ? { headers: data.headers } : {}),
    ...(data.sessionMode ? { sessionMode: data.sessionMode } : {}),
    ...(data.version ? { version: data.version } : {}),
  };
}
