// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { MongoServerError, type Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class CreateProjectMemberships implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const name = "project_memberships";
    const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
    let cosmos = true;
    try {
      const result: unknown = await db.command(exists
        ? { customAction: "GetCollection", collection: name }
        : { customAction: "CreateCollection", collection: name, indexes: [
          { key: { _id: 1 }, name: "_id_1", unique: true },
          { key: { projectId: 1, userId: 1 }, name: "uniq_project_user", unique: true },
        ] });
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== 1) {
        throw new Error("[031] Invalid Cosmos collection response");
      }
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 59) throw error;
      cosmos = false;
    }
    const memberships = db.collection(name);
    if (!cosmos) await memberships.createIndex({ projectId: 1, userId: 1 }, { name: "uniq_project_user", unique: true });
    const indexes = await memberships.listIndexes().toArray();
    const unique = indexes.find(index => index.name === "uniq_project_user");
    if (!unique || unique.unique !== true || unique.sparse || unique.partialFilterExpression ||
      JSON.stringify(unique.key) !== JSON.stringify({ projectId: 1, userId: 1 })) {
      throw new Error("[031] Incompatible project membership uniqueness; operator repair required, no data was dropped");
    }
    await memberships.createIndex({ userId: 1 });
    await memberships.createIndex({ projectId: 1 });
    await db.collection("admin_operations").createIndex({ state: 1 });
    await db.collection("admin_operations").createIndex({ targetId: 1 });
    const operationIndexes = await db.collection("admin_operations").listIndexes().toArray();
    if (operationIndexes.some(index => "expireAfterSeconds" in index)) {
      throw new Error("[031] Administrative evidence has a TTL index; operator repair required before RBAC rollout");
    }
    await db.collection("reports").updateMany({ status: { $in: ["pending", "generating"] } }, {
      $set: { status: "failed", error: "report_generation_disabled", updatedAt: new Date() },
    });
    console.log("[031] Verified membership uniqueness; no legacy grants created; administrative intents have no TTL");
  }

  async down(): Promise<void> {
    console.log("[031-down] Retaining memberships and operation evidence; rollback must not reopen access");
  }
}
