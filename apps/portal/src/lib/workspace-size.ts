// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for displaying workspace snapshot sizes (#1564).
 *
 * Each completed iteration may record `workspaceSizeBytes` — the size of the
 * compressed workspace archive uploaded for that turn. Legacy and imported
 * runs predate the field, so a missing size must read as "unavailable" rather
 * than as zero bytes.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Format a byte count using binary (1024-based) units up to TB.
 *
 * @param bytes - Non-negative byte count.
 * @returns e.g. `"512 B"`, `"1.5 KB"`, `"2.3 GB"`.
 */
export function formatSnapshotBytes(bytes: number): string {
  let size = bytes;
  let unitIndex = 0;

  // Step up a unit while the value is at least 1024 and a larger unit exists.
  while (size >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return unitIndex === 0 ? `${size} B` : `${size.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

/** Aggregate of the snapshot sizes recorded across a run's turns. */
export interface WorkspaceSizeSummary {
  /** Sum of every recorded `workspaceSizeBytes`, in bytes. */
  totalBytes: number;
  /** Number of turns that recorded a size. */
  measured: number;
  /** Number of turns with no recorded size (legacy/imported or upload skipped). */
  missing: number;
}

/**
 * Sum the recorded workspace snapshot sizes of a set of turns.
 *
 * @param turns - Turns of a single run attempt.
 * @returns Totals plus how many turns had (or lacked) a recorded size.
 */
export function summarizeWorkspaceSizes(
  turns: ReadonlyArray<{ workspaceSizeBytes?: number }>,
): WorkspaceSizeSummary {
  let totalBytes = 0;
  let measured = 0;

  for (const turn of turns) {
    if (typeof turn.workspaceSizeBytes === "number") {
      totalBytes += turn.workspaceSizeBytes;
      measured++;
    }
  }

  return { totalBytes, measured, missing: turns.length - measured };
}
