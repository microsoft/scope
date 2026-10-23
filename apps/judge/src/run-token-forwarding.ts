// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { parseRunToken } from "shared";

/**
 * Extract the caller's run token from an `Authorization` header so the judge can
 * forward it on its own API reads. Only well-formed run tokens are forwarded;
 * anything else (missing, other schemes, user tokens) yields `undefined`.
 */
export function forwardableRunToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) return undefined;
  const token = match[1];
  return parseRunToken(token) ? token : undefined;
}
