// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { deriveCapabilities } from "./capabilities.js";
import type { KeyValidationResult } from "./types.js";

const validResult: KeyValidationResult = { status: "valid" };
const invalidResult: KeyValidationResult = { status: "invalid" };

describe("deriveCapabilities", () => {
  it("returns empty array for non-valid status", () => {
    expect(deriveCapabilities("github-oauth", invalidResult)).toEqual([]);
  });

  describe("github-pat-classic", () => {
    it("returns github-public-api + copilot capabilities when copilot scope is present", () => {
      const result: KeyValidationResult = {
        status: "valid",
        scopes: ["copilot", "repo"],
      };
      expect(deriveCapabilities("github-pat-classic", result)).toEqual([
        "github-public-api",
        "copilot-sdk",
        "copilot-cli",
      ]);
    });

    it("does NOT include copilot-models (PATs rejected by Copilot models API)", () => {
      const result: KeyValidationResult = {
        status: "valid",
        scopes: ["copilot"],
      };
      const caps = deriveCapabilities("github-pat-classic", result);
      expect(caps).not.toContain("copilot-models");
    });

    it("returns just github-public-api when copilot scope is missing", () => {
      const result: KeyValidationResult = {
        status: "valid",
        scopes: ["repo"],
      };
      expect(deriveCapabilities("github-pat-classic", result)).toEqual([
        "github-public-api",
      ]);
    });
  });

  describe("github-pat-fine-grained", () => {
    it("returns github-public-api + github-models when capability was probed", () => {
      const result: KeyValidationResult = {
        status: "valid",
        capabilities: ["github-models"],
      };
      expect(deriveCapabilities("github-pat-fine-grained", result)).toEqual([
        "github-public-api",
        "github-models",
      ]);
    });

    it("returns just github-public-api when no capabilities probed", () => {
      expect(deriveCapabilities("github-pat-fine-grained", validResult)).toEqual([
        "github-public-api",
      ]);
    });
  });

  describe("github-oauth", () => {
    it("includes copilot-models capability", () => {
      const caps = deriveCapabilities("github-oauth", validResult);
      expect(caps).toContain("copilot-models");
    });

    it("includes all expected capabilities", () => {
      expect(deriveCapabilities("github-oauth", validResult)).toEqual([
        "github-models",
        "github-public-api",
        "copilot-models",
        "copilot-sdk",
        "copilot-cli",
      ]);
    });
  });
  describe("anthropic-api-key", () => {
    it("returns claude-code-cli and anthropic-api", () => {
      expect(deriveCapabilities("anthropic-api-key", validResult)).toEqual([
        "claude-code-cli",
        "anthropic-api",
      ]);
    });
  });

  describe("anthropic-oauth", () => {
    it("returns only claude-code-cli (no anthropic-api)", () => {
      expect(deriveCapabilities("anthropic-oauth", validResult)).toEqual([
        "claude-code-cli",
      ]);
    });

    it("returns empty array for non-valid status", () => {
      expect(deriveCapabilities("anthropic-oauth", invalidResult)).toEqual([]);
    });
  });

  describe("azure-ai-foundry", () => {
    it("returns azure-ai-inference when valid", () => {
      expect(deriveCapabilities("azure-ai-foundry", validResult)).toEqual([
        "azure-ai-inference",
      ]);
    });

    it("returns empty array for non-valid status", () => {
      expect(deriveCapabilities("azure-ai-foundry", invalidResult)).toEqual([]);
    });
  });
});
