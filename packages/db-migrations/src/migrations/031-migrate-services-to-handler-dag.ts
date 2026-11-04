// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

/**
 * Migration 031: Remove the legacy "post-processor" service entry.
 *
 * Handler service registration (pp-atif, pp-taxonomy) is now owned
 * by each worker's handler.yaml + the generic register-handler script,
 * which POSTs to the scheduler's POST /handlers/register endpoint on deploy.
 * Reports are not a DAG handler — the scheduler triggers report generation
 * (POST /api/v1/reports/trigger) once the DAG drains.
 * This migration only cleans up the old single-entry format.
 */
export class MigrateServicesToHandlerDag implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const services = db.collection("services");
    await services.deleteOne({ _id: "post-processor" } as any);
    console.log("[031] Deleted legacy post-processor service entry (handler registration now owned by workers)");
  }

  async down(db: Db): Promise<void> {
    const services = db.collection("services");
    await services.updateOne(
      { _id: "post-processor" } as any,
      {
        $set: { version: 2 },
        $unset: {
          type: "",
          queue: "",
          selector: "",
          autoBackfill: "",
          dependsOn: "",
        },
      },
      { upsert: true },
    );
    console.log("[031-down] Restored legacy post-processor service entry");
  }
}
