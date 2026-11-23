// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { OpenAPIObject } from "openapi3-ts/oas31";

/**
 * Serialize a generated document with stable object keys, two-space indentation,
 * LF line endings, and a trailing newline. Array order is preserved.
 * @param document OpenAPI document containing JSON-compatible values.
 */
export function serializeOpenAPIDocument(document: OpenAPIObject): string {
  return JSON.stringify(document, (_key, value: unknown): unknown => {
    // Canonicalize objects at every depth without reordering arrays.
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object).sort().map((key) => [key, object[key]]),
      );
    }
    return value;
  }, 2) + "\n";
}
