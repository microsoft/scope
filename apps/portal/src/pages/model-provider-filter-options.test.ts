// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { buildModelProviderFilterOptions } from "./model-provider-filter-options";

describe("buildModelProviderFilterOptions", () => {
  it("uses each provider value as its distinct display label", () => {
    expect(
      buildModelProviderFilterOptions([
        { provider: "github-copilot" },
        { provider: "anthropic" },
      ]),
    ).toEqual([
      { value: "anthropic", label: "anthropic", count: 1 },
      { value: "github-copilot", label: "github-copilot", count: 1 },
    ]);
  });

  it("groups repeated provider values into one counted option", () => {
    expect(
      buildModelProviderFilterOptions([
        { provider: "github-copilot" },
        { provider: "github-copilot" },
      ]),
    ).toEqual([
      { value: "github-copilot", label: "github-copilot", count: 2 },
    ]);
  });
});
