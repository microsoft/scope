// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const HANDLER_STATUS_INDEXES = [
  {
    name: "idx_handler_dispatch_atif",
    key: {
      "run.handlerStatus.pp-atif.status": 1 as const,
      "run.status": 1 as const,
      updatedAt: -1 as const,
    },
  },
  {
    name: "idx_handler_dispatch_taxonomy",
    key: {
      "run.handlerStatus.pp-taxonomy.status": 1 as const,
      "run.status": 1 as const,
      updatedAt: -1 as const,
    },
  },
] as const;

export class AddHandlerStatusIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const requests = db.collection("requests");

    for (const index of HANDLER_STATUS_INDEXES) {
      try {
        const createdName = await requests.createIndex(index.key, { name: index.name });
        const exists = await requests.indexExists(createdName);
        console.log(
          exists
            ? `[032] Created ${index.name} index on requests`
            : `[032] ${index.name} was requested but is not visible in getIndexes()`,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[032] ${index.name} already exists or couldn't be created: ${message}`);
      }
    }
  }

  async down(db: Db): Promise<void> {
    const requests = db.collection("requests");

    for (const index of HANDLER_STATUS_INDEXES) {
      try {
        await requests.dropIndex(index.name);
        console.log(`[032-down] Dropped ${index.name} index`);
      } catch (err: unknown) {
        const codeName = typeof err === "object" && err !== null && "codeName" in err
          ? String((err as { codeName?: unknown }).codeName)
          : undefined;
        if (codeName !== "IndexNotFound") {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`[032-down] ${index.name} not found: ${message}`);
        }
      }
    }
  }
}
