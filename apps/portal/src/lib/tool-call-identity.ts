// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface McpToolIdentity {
  server: string;
  tool: string;
}

/** Keep ambiguous flattened names intact unless the run identifies their server. */
export function getMcpToolIdentity(name: string, servers: readonly string[] = []): McpToolIdentity | undefined {
  const namespaced = /^mcp__([a-zA-Z0-9_-]+?)__(\S+)$/.exec(name);
  if (namespaced?.[1] && namespaced[2]) {
    return { server: namespaced[1], tool: namespaced[2] };
  }

  // Copilot flattens MCP names as "<server>-<tool>". Server names can contain
  // hyphens too, so match the longest configured prefix, not the first hyphen.
  const server = servers
    .filter((candidate) => candidate.length > 0 && name.startsWith(`${candidate}-`) && name.length > candidate.length + 1)
    .sort((a, b) => b.length - a.length)[0];
  return server ? { server, tool: name.slice(server.length + 1) } : undefined;
}
