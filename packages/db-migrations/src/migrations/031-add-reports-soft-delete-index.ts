// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { ensureIndex } from "../cosmos-index-helpers.js";

const TAG = "031";

export class AddReportsSoftDeleteIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    await ensureIndex(
      db.collection("reports"),
      { deletedAt: 1 },
      {},
      "reports",
      TAG,
    );
    console.log(`[${TAG}] Reports soft-delete index complete`);
  }

  async down(_db: Db): Promise<void> {
    console.log(
      `  [${TAG}-down] Skipping index changes — drop the reports deletedAt index manually if needed`,
    );
  }
}
