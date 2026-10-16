// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for detecting and presenting MCP tool calls in the conversation view.
 *
 * Tool-call names (confirmed against real integration runs) are built by two
 * layers. The Copilot CLI always prefixes a server's tools with
 * `<cliServerName>-` (single hyphen). Our gateway-routed servers all reach the
 * CLI under one registered server, `mcp-gateway` (the Copilot worker registers
 * it at `coder-acp-copilot/src/index.ts`), and the MCP gateway (MCPJungle)
 * additionally namespaces each underlying server's tools by slug with a double
 * underscore: `<serverSlug>__<toolName>` (see `docs/architecture/mcp-gateway.md`).
 *
 * So a gateway-routed tool appears as `mcp-gateway-<serverSlug>__<toolName>`
 * (e.g. `mcp-gateway-ms-learn__microsoft_docs_search`): the `__` lives only
 * inside the tool portion. A CLI-bundled server that isn't routed through our
 * gateway appears as `<cliServerName>-<toolName>` with no `__` (e.g.
 * `github-mcp-server-search_code`), so it never resolves to a configured MCP
 * server and renders as a built-in tool. Built-in tools (e.g. `bash`, `view`,
 * `edit`) carry no server prefix.
 *
 * Given the list of MCP server slugs configured on a run, we strip an optional
 * leading `mcp-gateway-` prefix, then detect the configured server slug and
 * split out the server + tool name for display.
 */

/** Prefix the Copilot CLI adds to tools of the `mcp-gateway` server it is given. */
const GATEWAY_PREFIX = "mcp-gateway-";

/** MCPJungle's separator between a server slug and its tool name. */
const SLUG_TOOL_SEPARATOR = "__";

export interface McpToolInfo {
  /** Whether this tool call resolved to a configured MCP server. */
  isMcp: boolean;
  /** The MCP server name (only set when `isMcp` is true). */
  server?: string;
  /** The tool name with the server prefix stripped (falls back to the raw name). */
  tool: string;
}

/**
 * Resolve MCP metadata for a tool call name against the run's configured MCP
 * server slugs. An optional leading `mcp-gateway-` prefix is stripped, then the
 * remainder must be `<slug>__<tool>` for one of the configured slugs. When
 * multiple slugs match, the longest wins so overlapping slugs resolve to the
 * most specific server.
 */
export function resolveMcpToolName(
  name: string,
  mcpServerNames: readonly string[] = [],
): McpToolInfo {
  const candidate = name.startsWith(GATEWAY_PREFIX) ? name.slice(GATEWAY_PREFIX.length) : name;

  let best: { server: string; tool: string } | undefined;

  for (const server of mcpServerNames) {
    if (!server) continue;
    const prefix = `${server}${SLUG_TOOL_SEPARATOR}`;
    if (candidate.startsWith(prefix) && candidate.length > prefix.length) {
      if (!best || server.length > best.server.length) {
        best = { server, tool: candidate.slice(prefix.length) };
      }
    }
  }

  if (best) {
    return { isMcp: true, server: best.server, tool: best.tool };
  }
  return { isMcp: false, tool: name };
}
