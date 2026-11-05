// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RunState } from "@/types";

export type PostProcessorStatus = "queued" | "processing" | "done" | "failed";

/**
 * Derive the aggregate enrichment status across the whole post-processing
 * handler DAG (issue #1147), rather than trusting the legacy single
 * `postProcessorStatus` scalar.
 *
 * Each post-processor handler overwrites that scalar on its own completion, so
 * it flips to "done" as soon as the FIRST handler (pp-atif) finishes — even
 * while pp-taxonomy is still computing observations. The "Enriched" badge (and
 * the run-detail poller) must instead stay "Enriching…" until every handler in
 * the DAG is terminal.
 *
 * Known topology: pp-atif always runs; pp-taxonomy is expected whenever the run
 * has configured observations. We treat taxonomy as still-pending until
 * pp-taxonomy reaches a terminal state, which also covers the brief window
 * after pp-atif finishes but before the scheduler has dispatched pp-taxonomy
 * (so it isn't yet present in `handlerStatus`).
 *
 * Falls back to the legacy `postProcessorStatus` scalar for runs that predate
 * the handler DAG (no `handlerStatus` map).
 */
export function deriveEnrichmentStatus(
  run: RunState | undefined,
  hasConfiguredObservations: boolean,
): PostProcessorStatus | undefined {
  if (!run) return undefined;
  const handlerStatus = run.handlerStatus;
  // Legacy runs predating the handler DAG only carry the scalar field.
  if (!handlerStatus || Object.keys(handlerStatus).length === 0) {
    return run.postProcessorStatus;
  }
  const statuses = Object.values(handlerStatus).map((h) => h?.status);
  const taxonomyStatus = handlerStatus["pp-taxonomy"]?.status;
  const taxonomyPending =
    hasConfiguredObservations && taxonomyStatus !== "done" && taxonomyStatus !== "failed";
  if (taxonomyPending || statuses.some((s) => s === "queued" || s === "processing")) {
    return "processing";
  }
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.length > 0 && statuses.every((s) => s === "done")) return "done";
  return run.postProcessorStatus;
}
