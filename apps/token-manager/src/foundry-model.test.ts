// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import type { KeyDocument } from "shared";
import type { SecretStore } from "./keyvault-store.js";
import {
  buildFoundryModelSecret,
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

    const value = await buildFoundryModelSecret(token, " new-model ", store);

    expect(JSON.parse(value!)).toEqual({
      endpoint: "https://example.services.ai.azure.com/models",
      apiKey: "secret-api-key",
      model: "new-model",
    });
    expect(store.setSecret).not.toHaveBeenCalled();
    expect(JSON.parse(getValue())).toMatchObject({ model: "old-model" });
  });

  it("returns metadata when the model cannot be read from Key Vault", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      getSecret: vi.fn(async () => {
        throw new Error("Key Vault unavailable");
      }),
    } as unknown as SecretStore;

    await expect(withFoundryModel(token, store)).resolves.toEqual(token);
    expect(warn).toHaveBeenCalledWith(
      `[foundry-model] Failed to project model for ${token._id}:`,
      "Key Vault unavailable"
    );
    warn.mockRestore();
  });
});
