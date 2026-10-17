// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { ensureIndex } from "../cosmos-index-helpers.js";

const TAG = "036";

export class AddExperimentLifecycleIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    await ensureIndex(
      db.collection("experiments"),
      { "lifecycle.phase": 1, updatedAt: 1 },
      {},
      "experiments",
      TAG,
    );
    await ensureIndex(
      db.collection("requests"),
      { "deletionProvenance.operationId": 1 },
      {},
      "requests",
      TAG,
    );
    await ensureIndex(
      db.collection("reports"),
      { experimentId: 1 },
      {},
      "reports",
      TAG,
    );
    await ensureIndex(
      db.collection("reports"),
      { "deletionProvenance.operationId": 1 },
      {},
      "reports",
      TAG,
    );
    console.log(`[${TAG}] Experiment lifecycle indexes complete`);
  }

  async down(_db: Db): Promise<void> {
    console.log(
      `[${TAG}-down] Skipping index changes - drop lifecycle indexes manually if needed`,
    );
  }
}
