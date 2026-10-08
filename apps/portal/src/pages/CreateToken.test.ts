// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { buildFoundryCredentialValue } from "./CreateToken.js";

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
