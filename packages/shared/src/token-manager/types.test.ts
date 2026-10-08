// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { INTERNAL_KEY_TYPES, isKeyType, KEY_TYPES, parseAzureAiFoundrySecret, USER_KEY_TYPES } from "./types.js";

describe("key type lists", () => {
  it("splits every key type into exactly one of user-facing or internal", () => {
    expect([...USER_KEY_TYPES, ...INTERNAL_KEY_TYPES].sort()).toEqual([...KEY_TYPES].sort());
    expect(USER_KEY_TYPES).not.toContain("github-oauth-cookie-state");
  });

  it("recognises only known key types", () => {
    expect(isKeyType("anthropic-api-key")).toBe(true);
    expect(isKeyType("github-oauth-cookie-state")).toBe(true);
    expect(isKeyType("unknown")).toBe(false);
    expect(isKeyType(undefined)).toBe(false);
  });
});

describe("parseAzureAiFoundrySecret", () => {
  it("parses a well-formed blob with endpoint, apiKey, and model", () => {
    const raw = JSON.stringify({
      endpoint: "https://my-resource.services.ai.azure.com/models",
      apiKey: "secret-key",
      model: "gpt-4.1",
    });
    expect(parseAzureAiFoundrySecret(raw)).toEqual({
      endpoint: "https://my-resource.services.ai.azure.com/models",
      apiKey: "secret-key",
      model: "gpt-4.1",
    });
  });

  it("parses a blob without an optional model field", () => {
    const raw = JSON.stringify({
      endpoint: "https://x.services.ai.azure.com/models",
      apiKey: "k",
    });
    expect(parseAzureAiFoundrySecret(raw)).toEqual({
      endpoint: "https://x.services.ai.azure.com/models",
      apiKey: "k",
      model: undefined,
    });
  });

  it("strips trailing slashes from the endpoint", () => {
    const raw = JSON.stringify({
      endpoint: "https://x.services.ai.azure.com/models///",
      apiKey: "k",
    });
    expect(parseAzureAiFoundrySecret(raw)?.endpoint).toBe(
      "https://x.services.ai.azure.com/models"
    );
  });

  it("returns null for invalid JSON", () => {
    expect(parseAzureAiFoundrySecret("not json")).toBeNull();
  });

  it("returns null for a JSON value that is not an object", () => {
    expect(parseAzureAiFoundrySecret(JSON.stringify("just a string"))).toBeNull();
    expect(parseAzureAiFoundrySecret(JSON.stringify(42))).toBeNull();
    expect(parseAzureAiFoundrySecret(JSON.stringify(null))).toBeNull();
  });

  it("returns null when endpoint is missing", () => {
    expect(parseAzureAiFoundrySecret(JSON.stringify({ apiKey: "k" }))).toBeNull();
  });

  it("returns null when apiKey is missing", () => {
    expect(
      parseAzureAiFoundrySecret(JSON.stringify({ endpoint: "https://x" }))
    ).toBeNull();
  });

  it("returns null when endpoint or apiKey is empty/whitespace", () => {
    expect(
      parseAzureAiFoundrySecret(JSON.stringify({ endpoint: "  ", apiKey: "k" }))
    ).toBeNull();
    expect(
      parseAzureAiFoundrySecret(JSON.stringify({ endpoint: "https://x", apiKey: "" }))
    ).toBeNull();
  });

  it("ignores non-string model values", () => {
    const raw = JSON.stringify({
      endpoint: "https://x",
      apiKey: "k",
      model: 42,
    });
    expect(parseAzureAiFoundrySecret(raw)?.model).toBeUndefined();
  });

  it("ignores request profiles from credentials created by older versions", () => {
    const raw = JSON.stringify({
      endpoint: "https://x",
      apiKey: "k",
      requestProfile: "future",
    });
    expect(parseAzureAiFoundrySecret(raw)).toEqual({
      endpoint: "https://x",
      apiKey: "k",
    });
  });
});
