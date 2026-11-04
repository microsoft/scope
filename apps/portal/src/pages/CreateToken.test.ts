// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { buildFoundryCredentialValue, KEY_INSTRUCTIONS } from "./CreateToken.js";

describe("Foundry credential value", () => {
  it("stores endpoint, key, and model without request compatibility fields", () => {
    expect(
      JSON.parse(
        buildFoundryCredentialValue({
          endpoint: "https://example.services.ai.azure.com/models/",
          apiKey: "test-key",
          model: "custom-production-deployment",
        }),
      ),
    ).toEqual({
      endpoint: "https://example.services.ai.azure.com/models",
      apiKey: "test-key",
      model: "custom-production-deployment",
    });
  });
});

describe("Portal AI token registration guidance", () => {
  it("recommends classic PAT Copilot SDK capability for Portal AI", () => {
    expect(KEY_INSTRUCTIONS["github-pat-classic"].steps.join(" ")).toContain(
      "enable Portal AI through the Copilot SDK",
    );
    expect(KEY_INSTRUCTIONS["github-pat-classic"].note).toContain(
      "recommended GitHub credential for Portal AI",
    );
  });

  it("describes GitHub Models as a legacy fallback", () => {
    expect(KEY_INSTRUCTIONS["github-pat-fine-grained"].note).toContain(
      "legacy GitHub Models",
    );
    expect(KEY_INSTRUCTIONS["github-oauth"].note).toContain(
      "GitHub Models remains a legacy fallback",
    );
  });

  it("documents Portal AI provider precedence for Foundry registration", () => {
    expect(KEY_INSTRUCTIONS["azure-ai-foundry"].note).toContain(
      "Foundry environment credentials take first priority",
    );
    expect(KEY_INSTRUCTIONS["azure-ai-foundry"].note).toContain(
      "registered Foundry keys, Copilot SDK credentials",
    );
  });
});
