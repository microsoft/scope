// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const INDEXES = [
  {
    collection: "taxonomies",
    indexes: [
      { key: { projectId: 1 } },
      { key: { id: 1 } },
      { key: { deletedAt: 1 } },
      { key: { projectId: 1, id: 1 }, unique: true },
    ],
  },
  {
    collection: "taxonomy-revisions",
    indexes: [
      { key: { taxonomyId: 1 } },
      { key: { projectId: 1 } },
      { key: { ref: 1 } },
      { key: { taxonomyId: 1, revision: -1 }, unique: true },
    ],
  },
  {
    collection: "taxonomy-elements",
    indexes: [
      { key: { projectId: 1 } },
      { key: { id: 1 } },
      { key: { deletedAt: 1 } },
      { key: { projectId: 1, id: 1 }, unique: true },
    ],
  },
  {
    collection: "taxonomy-element-revisions",
    indexes: [
      { key: { elementId: 1 } },
      { key: { projectId: 1 } },
      { key: { ref: 1 } },
      { key: { elementId: 1, revision: -1 }, unique: true },
    ],
  },
] as const;

/** Creates the four focused Cosmos-compatible taxonomy collection indexes. */
export class CreateTaxonomyIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const definition of INDEXES) {
      const collection = db.collection(definition.collection);
      for (const index of definition.indexes) {
        try {
          await collection.createIndex(index.key, {
            ...("unique" in index ? { unique: index.unique } : {}),
          });
          console.log(
            `  Created index ${JSON.stringify(index.key)} on ${definition.collection}`,
          );
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(
            `  Index ${JSON.stringify(index.key)} on ${definition.collection} already exists or could not be created: ${message}`,
          );
        }
      }

      const indexes = await collection.listIndexes().toArray();
      console.log(
        `  Verified ${definition.collection} getIndexes(): ${indexes.map((index) => index.name).join(", ")}`,
      );
    }
  }

  async down(): Promise<void> {
    console.log(
      "  Skipping taxonomy index drops — indexes should be removed manually if needed",
    );
  }
}
