// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// history.ts — Remember the last recipe for the "Run again" shortcut
// =============================================================================
// Stored per worktree under the gitignored .dev-state/ directory. History is a
// convenience: read and write failures are ignored rather than blocking the guide.
// =============================================================================

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** History file location, relative to the repository root. */
export const HISTORY_FILE = ".dev-state/guide/last.json";

/** Persisted shape of the history file. */
interface HistoryEntry {
  /** Id of the last recipe the user chose to run. */
  recipeId: string;
  /** ISO timestamp of that run. */
  ranAt: string;
}

/**
 * Read the id of the last recipe run in this worktree.
 *
 * @returns The recipe id, or `undefined` when there is no valid history.
 */
export function readLastRecipeId(root: string): string | undefined {
  try {
    const entry: unknown = JSON.parse(readFileSync(join(root, HISTORY_FILE), "utf8"));
    if (entry && typeof entry === "object" && "recipeId" in entry && typeof entry.recipeId === "string") return entry.recipeId;
  } catch {
    // Missing or corrupt history simply hides the "Run again" shortcut.
  }
  return undefined;
}

/**
 * Remember a recipe as the last one run in this worktree.
 *
 * @param now - Timestamp to record (default: the current time).
 */
export function writeLastRecipeId(root: string, recipeId: string, now: Date = new Date()): void {
  const path = join(root, HISTORY_FILE);
  const entry: HistoryEntry = { recipeId, ranAt: now.toISOString() };

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`);
  } catch {
    // A read-only checkout should still be able to run commands.
  }
}
