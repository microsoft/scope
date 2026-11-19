// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Resource revision addressing helpers.
 *
 * Resource revisions are incremental immutable snapshots. The canonical ref is
 * purely `"{slug}@r{revisionNumber}"`; revision `_id`s are fresh UUIDs.
 */

/** Convert a human name into a URL-safe slug. */
export function slugifyResourceName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build the canonical resource revision ref string (`{slug}@r{N}`). */
export function buildResourceRevisionRef(slug: string, revisionNumber: number): string {
  return `${slug}@r${revisionNumber}`;
}

/**
 * Parse a resource revision ref back into its parts.
 *
 * - `"{slug}@r{N}"` → `{ slug, revisionNumber: N }`
 * - `"{slug}"` → `{ slug, revisionNumber: undefined }` (latest)
 * - anything else → `null`
 */
export function parseResourceRevisionRef(
  ref: string
): { slug: string; revisionNumber?: number } | null {
  const withRev = /^(.+)@r(\d+)$/.exec(ref);
  if (withRev) {
    return { slug: withRev[1], revisionNumber: Number(withRev[2]) };
  }
  if (ref.includes("@")) return null;
  if (!ref.trim()) return null;
  return { slug: ref };
}
