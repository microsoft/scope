// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Create a sparse single-field index for experiment correlation.
 *
 * Cosmos DB can intersect this equality index with the existing project and
 * deletion filters used by the Runs API. Keeping it sparse avoids write RU
 * overhead for ordinary runs that do not belong to an experiment.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddExperimentIdIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const collection = db.collection("requests");
    try {
      await collection.createIndex({ experimentId: 1 }, { sparse: true });
      console.log("[031] Created sparse index on requests.experimentId");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `[031] Index on requests.experimentId already exists or could not be created: ${message}`,
      );
    }
  }

  async down(_db: Db): Promise<void> {
    console.log(
      "[031-down] Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
