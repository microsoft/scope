// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const SLASH = 0x2f;

/**
 * Remove every trailing `/` from `value` (e.g. `"https://x.test///"` →
 * `"https://x.test"`). Strings without trailing slashes are returned as-is,
 * and a string made only of slashes becomes `""`.
 *
 * Linear-time replacement for the trailing-slash regex replace, which
 * backtracks polynomially on a long run of `/` that is not at the end of the
 * input (CodeQL `js/polynomial-redos`).
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH) {
    end--;
  }
  return end === value.length ? value : value.slice(0, end);
}
