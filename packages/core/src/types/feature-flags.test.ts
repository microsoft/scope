// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import type { FeatureFlagDocument } from "./types.js";

describe("FeatureFlagDocument", () => {
  it("can create a valid feature flag", () => {
    const flag: FeatureFlagDocument = {
      key: "mcp",
      label: "MCP Servers",
      enabled: true,
      updatedAt: new Date(),
    };

    expect(flag.key).toBe("mcp");
    expect(flag.label).toBe("MCP Servers");
    expect(flag.enabled).toBe(true);
    expect(flag.updatedAt).toBeInstanceOf(Date);
  });

  it("supports all four default feature flag keys", () => {
    const keys = ["mcp", "models", "agents", "tokens"];
    const labels = ["MCP Servers", "Models", "Agents", "Tokens"];

    const flags: FeatureFlagDocument[] = keys.map((key, i) => ({
      key,
      label: labels[i],
      enabled: true,
      updatedAt: new Date(),
    }));

    expect(flags).toHaveLength(4);
    expect(flags.map((f) => f.key)).toEqual(keys);
  });

  it("can represent a disabled flag", () => {
    const flag: FeatureFlagDocument = {
      key: "tokens",
      label: "Tokens",
      enabled: false,
      updatedAt: new Date(),
    };

    expect(flag.enabled).toBe(false);
  });
});
