// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Backfill criteria kind.
 *
 * The observation-criteria feature (issue #1156) introduces a `kind` field on
 * criteria — `"gate"` (default) gates the coding-agent session via the DAG,
 * while `"observation"` is record-only. To preserve existing behaviour every
 * legacy criterion must be a gate, so we backfill rows whose `kind` field is
 * absent or null with `"gate"`. Mirrors 018-backfill-criteria-gates.ts.
 *
 * down() reverses only the rows this migration set to exactly "gate",
 * unsetting the field to restore the pre-migration state.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";

export class BackfillCriteriaKind implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const criteria = db.collection("criteria");

    const count = await batchUpdate(
      criteria,
      { $or: [{ kind: { $exists: false } }, { kind: null }] },
      { $set: { kind: "gate" } },
      "[021] backfill criteria.kind=gate",
    );

    console.log(`[021] Backfilled kind=gate on ${count} criteria`);
  }

  async down(db: Db): Promise<void> {
    const criteria = db.collection("criteria");

    const count = await batchUpdate(
      criteria,
      { kind: "gate" },
      { $unset: { kind: "" } },
      "[021-down] unset criteria.kind",
    );

    console.log(`[021-down] Unset kind on ${count} criteria`);
  }
}
