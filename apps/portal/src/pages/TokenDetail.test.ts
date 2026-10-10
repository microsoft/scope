// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { buildKeyUpdateRequest } from "./token-detail-utils.js";

describe("buildKeyUpdateRequest", () => {
  it("includes a trimmed model override for Azure AI Foundry keys", () => {
    expect(
      buildKeyUpdateRequest({
        type: "azure-ai-foundry",
        enabled: true,
        expiresAt: "",
        comment: " production ",
        foundryModel: " gpt-4.1-mini ",
      })
    ).toEqual({
      enabled: true,
      expiresAt: null,
      comment: "production",
      model: "gpt-4.1-mini",
    });
  });

  it("does not send a model field for other key types", () => {
    expect(
      buildKeyUpdateRequest({
        type: "github-oauth",
        enabled: true,
        expiresAt: "",
        comment: "",
        foundryModel: "ignored",
      })
    ).toEqual({
      enabled: true,
      expiresAt: null,
      comment: null,
    });
  });
});
