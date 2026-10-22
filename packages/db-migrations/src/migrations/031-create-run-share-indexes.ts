// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { ensureIndex } from "../cosmos-index-helpers.js";

export class CreateRunShareIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("run-shares");
    for (const field of ["requestId", "runId", "projectId", "createdBy"]) {
      await ensureIndex(col, { [field]: 1 }, {}, "run-shares", "031");
    }
    await ensureIndex(db.collection("reports"), { runId: 1 }, {}, "reports", "031");
    const reportIndexes = await db.collection("reports").indexes();
    if (!reportIndexes.some((index) => index.key.runId === 1 && Object.keys(index.key).length === 1)) {
      throw new Error("[031] Missing reports index on runId");
    }
    const indexes = await col.indexes();
    for (const field of ["requestId", "runId", "projectId", "createdBy"]) {
      if (!indexes.some((index) => index.key[field] === 1 && Object.keys(index.key).length === 1)) {
        throw new Error(`[031] Missing run-shares index on ${field}`);
      }
    }
  }

  async down(_db: Db): Promise<void> {
    console.log("[031-down] Keeping run-share data and indexes; remove manually if needed");
  }
}
