// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { parseAzureAiFoundrySecret, parseOpenAiSecret, portalAiCredential } from "./types.js";

describe("Portal AI credential configuration", () => {
  it("normalizes compatible endpoints and requires a model", () => {
    expect(parseOpenAiSecret('{"endpoint":"https://provider.test/v1/","apiKey":" k ","model":" m "}'))
      .toEqual({ endpoint: "https://provider.test/v1", apiKey: "k", model: "m" });
    expect(parseOpenAiSecret('{"endpoint":"https://provider.test","apiKey":"k"}')).toBeNull();
  });
  it.each(["http://provider.test/v1", "file:///etc/config", "https://user:password@provider.test", "https://provider.test?key=k"])("rejects unsafe endpoint %s", (endpoint) => {
    expect(parseOpenAiSecret(JSON.stringify({ endpoint, apiKey: "k", model: "m" }))).toBeNull();
  });
  it("allows an explicitly configured localhost compatible server", () => {
    expect(parseOpenAiSecret('{"endpoint":"http://127.0.0.1:8000/v1","apiKey":"local","model":"m"}')).not.toBeNull();
  });
  it("reuses the existing Anthropic API key, not subscription OAuth", () => {
    expect(portalAiCredential("anthropic")).toEqual({ capability: "anthropic-api", keyType: "anthropic-api-key" });
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
});
