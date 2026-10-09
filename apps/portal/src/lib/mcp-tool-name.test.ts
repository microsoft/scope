// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { resolveMcpToolName } from "./mcp-tool-name";

describe("resolveMcpToolName", () => {
  it("returns built-in tools unchanged when no servers configured", () => {
    expect(resolveMcpToolName("bash")).toEqual({ isMcp: false, tool: "bash" });
  });

  it("does not flag built-in tools that don't match a server prefix", () => {
    expect(resolveMcpToolName("view", ["github-mcp-server"])).toEqual({
      isMcp: false,
      tool: "view",
    });
  });

  it("detects an MCP tool and splits server + tool name", () => {
    expect(resolveMcpToolName("github-mcp-server__search_code", ["github-mcp-server"])).toEqual({
      isMcp: true,
      server: "github-mcp-server",
      tool: "search_code",
    });
  });

  // Real names captured from an integration run (mcpServers: ["ms-learn"]).
  // The CLI always prefixes with `<cliServerName>-` (single hyphen); the gateway's
  // `<slug>__<tool>` namespacing only appears inside the tool portion.
  it("resolves a real gateway-routed name (mcp-gateway- prefix + slug__tool)", () => {
    expect(
      resolveMcpToolName("mcp-gateway-ms-learn__microsoft_docs_search", ["ms-learn"]),
    ).toEqual({
      isMcp: true,
      server: "ms-learn",
      tool: "microsoft_docs_search",
    });
  });

  it("does not flag the CLI-bundled github server when it isn't a configured MCP server", () => {
    // github-mcp-server is bundled by the CLI, not routed through our gateway, so it's
    // absent from the run's configured mcpServers and must not render an MCP badge.
    expect(resolveMcpToolName("github-mcp-server-search_code", ["ms-learn"])).toEqual({
      isMcp: false,
      tool: "github-mcp-server-search_code",
    });
  });

  it("does not treat a single-hyphen name as MCP even when the slug is configured", () => {
    // Only `<slug>__<tool>` comes from the gateway; `<name>-<tool>` is a CLI-bundled
    // server and must not be mislabeled as one of the run's MCP servers.
    expect(resolveMcpToolName("github-mcp-server-search_code", ["github-mcp-server"])).toEqual({
      isMcp: false,
      tool: "github-mcp-server-search_code",
    });
  });

  it("handles slugs and tool names that themselves contain hyphens/underscores", () => {
    expect(
      resolveMcpToolName("filesystem__read_text_file", ["filesystem"]),
    ).toEqual({
      isMcp: true,
      server: "filesystem",
      tool: "read_text_file",
    });
  });

  it("matches the slug that directly precedes __ when slugs share a prefix", () => {
    const result = resolveMcpToolName("mcp-gateway-github-mcp-server__search_code", [
      "github",
      "github-mcp-server",
    ]);
    expect(result).toEqual({
      isMcp: true,
      server: "github-mcp-server",
      tool: "search_code",
    });
  });

  it("ignores empty server names", () => {
    expect(resolveMcpToolName("__foo", [""])).toEqual({ isMcp: false, tool: "__foo" });
  });

  it("requires a non-empty tool name after the prefix", () => {
    expect(resolveMcpToolName("mcp-gateway-server__", ["server"])).toEqual({
      isMcp: false,
      tool: "mcp-gateway-server__",
    });
  });
});
