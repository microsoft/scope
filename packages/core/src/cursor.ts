// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Generic cursor encoding/decoding for cursor-based pagination.
 *
 * Format: "key~value" pairs joined by "|"
 *   Single field:  "taskPromptId~tp-1"
 *   Multi-field:   "createdAt~2025-01-15T10:00:00.000Z|id~abc123"
 *
 * Uses `~` as key-value separator (`:` appears in ISO timestamps)
 * and `|` as pair separator.
 */

const PAIR_SEP = "|";
const KV_SEP = "~";

/** Encode a cursor from a key-value record. */
export function encodeCursor(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}${KV_SEP}${v}`)
    .join(PAIR_SEP);
}

/** Decode a cursor string into a key-value record. */
export function decodeCursor(encoded: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of encoded.split(PAIR_SEP)) {
    const idx = part.indexOf(KV_SEP);
    if (idx < 1) throw new Error(`Invalid cursor: missing '~' in segment '${part}'`);
    result[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return result;
}
