// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Escape user-entered search text for a literal substring match in MongoDB. */
export function escapeSearchText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
