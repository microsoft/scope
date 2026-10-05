// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Remove the `extensions` feature flag.
 *
 * VS Code extensions support is no longer toggled by a feature flag. The
 * portal now shows it only while at least one available coding agent declares
 * `capabilities.supportsExtensions: true`, so the seeded flag would leave a
 * no-op toggle in Admin. The API no longer seeds it; this removes existing
 * documents. `down()` restores the original seeded flag (enabled).
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const TAG = "031";
const COLLECTION = "feature-flags";
const FLAG_KEY = "extensions";

export class RemoveExtensionsFeatureFlag implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const result = await db.collection(COLLECTION).deleteMany({ key: FLAG_KEY });
    console.log(`[${TAG}] Removed ${result.deletedCount} "${FLAG_KEY}" feature flag document(s)`);
  }

  async down(db: Db): Promise<void> {
    await db.collection(COLLECTION).updateOne(
      { key: FLAG_KEY },
      {
        $setOnInsert: {
          key: FLAG_KEY,
          label: "VS Code Extensions",
          enabled: true,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    console.log(`[${TAG}-down] Restored "${FLAG_KEY}" feature flag`);
  }
}
