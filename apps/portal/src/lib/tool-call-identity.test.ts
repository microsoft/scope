// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { getMcpToolIdentity } from "./tool-call-identity";

describe("getMcpToolIdentity", () => {
  it("identifies explicit MCP namespaces without requiring a current catalog", () => {
    expect(getMcpToolIdentity("mcp__docs-server__search_docs")).toEqual({
      server: "docs-server", tool: "search_docs",
    });
  });

  it("preserves the complete tool name after the namespace separator", () => {
    expect(getMcpToolIdentity("mcp__docs__search__advanced")).toEqual({
      server: "docs", tool: "search__advanced",
    });
  });

  it("uses recorded server identifiers to recognize flattened Copilot names", () => {
    expect(getMcpToolIdentity("docs-server-search_docs", ["docs", "docs-server"])).toEqual({
      server: "docs-server", tool: "search_docs",
    });
  });

  it.each(["read_file", "functions.read_file", "multi_tool_use.parallel", "git-status", "docs-search", "mcp__", "mcp____search", "mcp__docs__", ""])(
    "does not guess MCP identity for %s without server metadata",
    (name) => expect(getMcpToolIdentity(name)).toBeUndefined(),
  );

  it("requires an exact non-empty configured prefix and a non-empty tool name", () => {
    expect(getMcpToolIdentity("docs-search", ["doc", ""])).toBeUndefined();
    expect(getMcpToolIdentity("docs-", ["docs"])).toBeUndefined();
    expect(getMcpToolIdentity("mcp_search", ["mcp"])).toBeUndefined();
  });
});
