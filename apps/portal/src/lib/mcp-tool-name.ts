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
 * `github-mcp-server-search_code`); since it isn't in the run's configured MCP
 * servers, it correctly resolves to a built-in (non-MCP) tool. Built-in tools
 * (e.g. `bash`, `view`, `edit`) carry no server prefix.
 *
 * Given the list of MCP server slugs configured on a run, we strip an optional
 * leading `mcp-gateway-` prefix, then detect the configured server slug and
 * split out the server + tool name for display.
 */

/** Server name the Copilot worker registers the gateway under with the CLI. */
const GATEWAY_SERVER_NAME = "mcp-gateway";

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
 * server slugs. Tries the `__` separator first (current gateway format), then
 * falls back to a legacy `-` separator. A leading `mcp-gateway__`/`mcp-gateway-`
 * prefix (added by the CLI when it re-namespaces the gateway's tools) is
 * stripped before matching. When multiple prefixes match, the longest server
 * slug wins so overlapping names resolve to the most specific match.
 */
export function resolveMcpToolName(
  name: string,
  mcpServerNames: readonly string[] = [],
): McpToolInfo {
  // Strip an optional gateway prefix so both `<slug>__<tool>` and
  // `mcp-gateway__<slug>__<tool>` resolve identically.
  let candidate = name;
  for (const sep of ["__", "-"]) {
    const gatewayPrefix = `${GATEWAY_SERVER_NAME}${sep}`;
    if (candidate.startsWith(gatewayPrefix) && candidate.length > gatewayPrefix.length) {
      candidate = candidate.slice(gatewayPrefix.length);
      break;
    }
  }

  let best: { server: string; tool: string } | undefined;

  for (const server of mcpServerNames) {
    if (!server) continue;
    for (const sep of ["__", "-"]) {
      const prefix = `${server}${sep}`;
      if (candidate.startsWith(prefix) && candidate.length > prefix.length) {
        const tool = candidate.slice(prefix.length);
        if (!best || server.length > best.server.length) {
          best = { server, tool };
        }
        break;
      }
    }
  }

  if (best) {
    return { isMcp: true, server: best.server, tool: best.tool };
  }
  return { isMcp: false, tool: name };
}
