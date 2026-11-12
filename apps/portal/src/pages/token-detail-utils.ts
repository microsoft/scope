// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { KeyType, UpdateKeyRequest } from "../types.js";

export function buildKeyUpdateRequest({
  type,
  enabled,
  expiresAt,
  comment,
  foundryModel,
  currentModel,
}: {
  type: KeyType;
  enabled: boolean;
  expiresAt: string;
  comment: string;
  foundryModel: string;
  currentModel?: string;
}): UpdateKeyRequest {
  return {
    enabled,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    comment: comment.trim() || null,
    ...(type === "azure-ai-foundry" && foundryModel.trim() !== (currentModel ?? "")
      ? { model: foundryModel.trim() || null }
      : {}),
  };
}
