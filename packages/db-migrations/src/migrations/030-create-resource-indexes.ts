// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Create indexes for resources and resource-revisions collections.
 *
 * Resources follow the same mutable identity + immutable revision-history model
 * as codebases, but their human keys are project-scoped from day one. Cosmos DB
 * may degrade the unique indexes to non-unique lookup indexes, so the API also
 * performs application-level duplicate checks for `{projectId, slug}` and
 * `{projectId, ref}`.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import {
  assertNoCompositeDuplicates,
  ensureIndex,
  ensureUniqueIndexOrFallback,
} from "../cosmos-index-helpers.js";

const TAG = "030";

export class CreateResourceIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    {
      const col = db.collection("resources");
      await assertNoCompositeDuplicates(col, ["projectId", "slug"], "resources", TAG);
      await ensureUniqueIndexOrFallback(col, { projectId: 1, slug: 1 }, "resources", TAG);
      await ensureIndex(col, { projectId: 1 }, {}, "resources", TAG);
      await ensureIndex(col, { createdAt: -1 }, {}, "resources", TAG);
      await ensureIndex(col, { deletedAt: 1 }, {}, "resources", TAG);
    }

    {
      const col = db.collection("resource-revisions");
      await assertNoCompositeDuplicates(col, ["projectId", "ref"], "resource-revisions", TAG);
      await ensureUniqueIndexOrFallback(col, { projectId: 1, ref: 1 }, "resource-revisions", TAG);
      await ensureIndex(col, { resourceId: 1 }, {}, "resource-revisions", TAG);
      await ensureIndex(col, { resourceId: 1, revisionNumber: -1 }, {}, "resource-revisions", TAG);
    }

    console.log(`[${TAG}] Resource indexes complete`);
  }

  async down(_db: Db): Promise<void> {
    console.log(
      `  [${TAG}-down] Skipping index changes — drop resource indexes manually if needed`,
    );
  }
}
