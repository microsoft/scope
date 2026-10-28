// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { ensureIndex } from "../cosmos-index-helpers.js";

const TAG = "034";

export class CreateExperimentStorageIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    await ensureIndex(
      db.collection("experiments"),
      { projectId: 1, _id: 1 },
      {},
      "experiments",
      TAG,
    );
    await ensureIndex(
      db.collection("experiment-executions"),
      { projectId: 1 },
      {},
      "experiment-executions",
      TAG,
    );
    await ensureIndex(
      db.collection("experiment-executions"),
      { experimentId: 1, attemptNumber: -1 },
      {},
      "experiment-executions",
      TAG,
    );
    console.log(`[${TAG}] Experiment storage indexes complete`);
  }

  async down(_db: Db): Promise<void> {
    console.log(
      `[${TAG}-down] Skipping index changes - drop experiment indexes manually if needed`,
    );
  }
}
