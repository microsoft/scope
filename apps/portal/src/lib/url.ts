// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Encode a query-string value, escaping only chars that break URL parsing.
 *
 * We avoid URLSearchParams and encodeURIComponent here because both
 * over-encode characters that are safe in query values — notably `~` and `|`
 * which we use as cursor delimiters (e.g. "createdAt~2025-01-15T10:00:00.000Z|id~abc").
 * This keeps URLs human-readable in browser devtools and logs.
 */
export function encodeQsValue(v: string): string {
  return v.replace(/[%&=+#\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Build a query string from non-undefined params. Arrays become repeated keys. */
export function qs(params: Record<string, string | string[] | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item != null) parts.push(`${k}=${encodeQsValue(item)}`);
      }
    } else {
      parts.push(`${k}=${encodeQsValue(v)}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Remove every trailing `/` (e.g. `"https://x.test///"` → `"https://x.test"`).
 *
 * Linear-time replacement for the trailing-slash regex replace, which
 * backtracks polynomially on a long run of `/` that is not at the end of the
 * input (CodeQL `js/polynomial-redos`). Mirrors `stripTrailingSlashes` in
 * `packages/shared`, which the portal does not depend on.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end--;
  }
  return end === value.length ? value : value.slice(0, end);
}
