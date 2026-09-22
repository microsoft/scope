// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { KeyType, UpdateKeyRequest } from "../types.js";

export function buildKeyUpdateRequest({
  type,
  enabled,
  expiresAt,
  comment,
  foundryModel,
}: {
  type: KeyType;
  enabled: boolean;
  expiresAt: string;
  comment: string;
  foundryModel: string;
}): UpdateKeyRequest {
  return {
    enabled,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    comment: comment.trim() || null,
    ...(type === "azure-ai-foundry"
      ? { model: foundryModel.trim() || null }
      : {}),
  };
}
