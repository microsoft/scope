// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { OpenAPIObject } from "openapi3-ts/oas31";

/**
 * Serialize a website specification with stable keys, two-space indentation,
 * LF line endings, and one trailing newline, without changing array order.
 * @param document Generated OpenAPI document; never mutated.
 */
export function serializeOpenAPIDocument(document: OpenAPIObject): string {
  return JSON.stringify(document, (_key: string, value: unknown): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    // Use code-unit ordering rather than the host's locale for reproducible keys.
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  }, 2) + "\n";
}
