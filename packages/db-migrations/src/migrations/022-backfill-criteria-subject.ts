// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Backfill criteria subject.
 *
 * The criterion `subject` field (issue #1156) controls the granularity at which
 * an observation criterion is evaluated: `"iteration"` (per-turn) or `"run"`
 * (once over the whole run). Gate criteria are always `"iteration"`.
 *
 * The backfill is kind-aware to match the new store defaults:
 *   - gate / legacy (kind absent) → "iteration"
 *   - observation                 → "run"
 *
 * Backfilling existing observations to "run" also corrects the
 * `dependency_added_then_removed` false-negative that arose when whole-run
 * observations were forced through per-iteration evaluation. Blast radius is
 * negligible — #1156 is unmerged, so there are no production observation
 * criteria yet. Mirrors 021-backfill-criteria-kind.ts.
 *
 * down() unsets `subject` on rows whose value is "run" or "iteration",
 * restoring the pre-migration state.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";

export class BackfillCriteriaSubject implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const criteria = db.collection("criteria");

    // Gate + legacy (kind absent/null) → "iteration".
    const gateCount = await batchUpdate(
      criteria,
      {
        $and: [
          { $or: [{ subject: { $exists: false } }, { subject: null }] },
          { $or: [{ kind: "gate" }, { kind: { $exists: false } }, { kind: null }] },
        ],
      },
      { $set: { subject: "iteration" } },
      "[022] backfill criteria.subject=iteration (gate/legacy)",
    );

    // Observation → "run".
    const obsCount = await batchUpdate(
      criteria,
      {
        $and: [
          { $or: [{ subject: { $exists: false } }, { subject: null }] },
          { kind: "observation" },
        ],
      },
      { $set: { subject: "run" } },
      "[022] backfill criteria.subject=run (observation)",
    );

    console.log(
      `[022] Backfilled subject: iteration on ${gateCount} gate/legacy criteria, run on ${obsCount} observation criteria`,
    );
  }

  async down(db: Db): Promise<void> {
    const criteria = db.collection("criteria");

    const count = await batchUpdate(
      criteria,
      { subject: { $in: ["run", "iteration"] } },
      { $unset: { subject: "" } },
      "[022-down] unset criteria.subject",
    );

    console.log(`[022-down] Unset subject on ${count} criteria`);
  }
}
