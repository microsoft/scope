// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AnyBulkWriteOperation, Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const BATCH_SIZE = 100;

type RequestWithPostProcessorState = {
  _id: string;
  run?: {
    postProcessorStatus?: "queued" | "processing" | "done" | "failed";
    postProcessorVersion?: number;
  };
};

export class BackfillHandlerStatus implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const requests = db.collection<RequestWithPostProcessorState>("requests");
    const cursor = requests.find(
      { "run.postProcessorVersion": { $exists: true } },
      {
        projection: {
          _id: 1,
          "run.postProcessorStatus": 1,
          "run.postProcessorVersion": 1,
        },
        batchSize: BATCH_SIZE,
      },
    );

    let processed = 0;
    let modified = 0;
    let batch: AnyBulkWriteOperation<RequestWithPostProcessorState>[] = [];

    for await (const doc of cursor) {
      const version = doc.run?.postProcessorVersion;
      if (version === undefined) {
        continue;
      }

      batch.push({
        updateOne: {
          filter: { _id: doc._id, "run.postProcessorVersion": { $exists: true } },
          update: {
            $set: {
              "run.handlerStatus.pp-atif": {
                status: doc.run?.postProcessorStatus ?? "done",
                version,
              },
            },
          },
        },
      });

      if (batch.length >= BATCH_SIZE) {
        const result = await requests.bulkWrite(batch, { ordered: false });
        processed += batch.length;
        modified += result.modifiedCount;
        batch = [];
      }
    }

    if (batch.length > 0) {
      const result = await requests.bulkWrite(batch, { ordered: false });
      processed += batch.length;
      modified += result.modifiedCount;
    }

    console.log(`  Backfilled handlerStatus for ${modified} runs (processed ${processed})`);
  }

  async down(_db: Db): Promise<void> {
    // No-op: deprecated flat fields remain intact for rollback compatibility.
  }
}
