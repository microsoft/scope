// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import type { KeyDocument } from "shared";
import type { SecretStore } from "./keyvault-store.js";
import {
  updateFoundryModelSecret,
  withFoundryModel,
} from "./foundry-model.js";

const token: KeyDocument = {
  _id: "foundry-key",
  type: "azure-ai-foundry",
  capabilities: ["azure-ai-inference"],
  secretName: "token-azure-ai-foundry-foundry",
  enabled: true,
  lastValidationStatus: "valid",
  acquireCount: 0,
  createdAt: new Date("2026-09-01T00:00:00Z"),
};

function makeStore() {
  let value = JSON.stringify({
    endpoint: "https://example.services.ai.azure.com/models",
    apiKey: "secret-api-key",
    model: "old-model",
  });
  return {
    store: {
      getSecret: vi.fn(async () => value),
      setSecret: vi.fn(async (_name: string, next: string) => {
        value = next;
      }),
    } as unknown as SecretStore,
    getValue: () => value,
  };
}

describe("Foundry model editing", () => {
  it("projects the model without exposing endpoint or API key", async () => {
    const { store } = makeStore();

    const detail = await withFoundryModel(token, store);

    expect(detail).toMatchObject({ model: "old-model" });
    expect(detail).not.toHaveProperty("endpoint");
    expect(detail).not.toHaveProperty("apiKey");
  });

  it("updates only the model and preserves the credential", async () => {
    const { store, getValue } = makeStore();

    await updateFoundryModelSecret(token, " new-model ", store);

    expect(JSON.parse(getValue())).toEqual({
      endpoint: "https://example.services.ai.azure.com/models",
      apiKey: "secret-api-key",
      model: "new-model",
    });
  });
});
