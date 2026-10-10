// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { KeyDocument } from "shared";
import { parseAzureAiFoundrySecret } from "shared";
import type { SecretStore } from "./keyvault-store.js";

/** Project only the non-secret model name into a single-key detail response. */
export async function withFoundryModel(
  token: KeyDocument,
  store: SecretStore
): Promise<KeyDocument> {
  if (token.type !== "azure-ai-foundry") {
    return token;
  }

  try {
    const parsed = parseAzureAiFoundrySecret(
      await store.getSecret(token.secretName)
    );
    return parsed?.model ? { ...token, model: parsed.model } : token;
  } catch (err) {
    console.warn(
      `[foundry-model] Failed to project model for ${token._id}:`,
      err instanceof Error ? err.message : err
    );
    return token;
  }
}

/** Build a new secret value without writing it, preserving the credential. */
export async function buildFoundryModelSecret(
  token: KeyDocument,
  model: string | null,
  store: SecretStore
): Promise<string | null> {
  const parsed = parseAzureAiFoundrySecret(
    await store.getSecret(token.secretName)
  );
  if (!parsed) return null;

  const value = JSON.stringify({
    ...parsed,
    model: model?.trim() || undefined,
  });
  return value;
}
