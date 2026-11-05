// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreateProjectMemberships } from "./migrations/031-create-project-memberships.js";

const uri = process.env.AUTH_TEST_MONGO_URI;
describe.skipIf(!uri)("Native Mongo membership authority migration", () => {
  let client: MongoClient;
  let db: Db;
  beforeEach(async () => {
    client = await MongoClient.connect(uri!);
    db = client.db(`rbac_membership_test_${randomUUID().replaceAll("-", "")}`);
  });
  afterEach(async () => { await db.dropDatabase(); await client.close(); });

  it("reruns without inventing grants and retains uniqueness after revoke/regrant", async () => {
    const migration = new CreateProjectMemberships();
    await migration.up(db);
    await migration.up(db);
    const members = db.collection("project_memberships");
    expect(await members.countDocuments()).toBe(0);
    await members.insertOne({ projectId: "a", userId: "bob", role: "reader", revision: 1 });
    await members.updateOne({ projectId: "a", userId: "bob", revision: 1 }, { $set: { revokedAt: new Date(), revision: 2 } });
    await expect(members.insertOne({ projectId: "a", userId: "bob", role: "admin" })).rejects.toMatchObject({ code: 11000 });
    await members.updateOne({ projectId: "a", userId: "bob", revision: 2 }, { $set: { role: "contributor", revision: 3 }, $unset: { revokedAt: "" } });
    expect(await members.countDocuments({ projectId: "a", userId: "bob" })).toBe(1);
    expect(await members.findOne({ projectId: "a", userId: "bob" })).toMatchObject({ role: "contributor", revision: 3 });
    expect((await db.collection("admin_operations").listIndexes().toArray()).some(index => "expireAfterSeconds" in index)).toBe(false);
  });

  it("fails closed rather than silently accepting automatic administrative-evidence pruning", async () => {
    await db.collection("admin_operations").createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
    await expect(new CreateProjectMemberships().up(db)).rejects.toThrow("TTL index");
    expect(await db.collection("admin_operations").listIndexes().toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ expireAfterSeconds: 86400 }),
    ]));
  });

  it("fails unfinished reports at cutover without changing stored terminal reports on rerun", async () => {
    const reports = db.collection<{
      status: "pending" | "generating" | "completed" | "failed";
      updatedAt: Date;
      content?: string;
      error?: string;
    }>("reports");
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await reports.insertMany([
      { status: "pending", updatedAt: timestamp },
      { status: "generating", updatedAt: timestamp },
      { status: "completed", updatedAt: timestamp, content: "Stored report" },
      { status: "failed", updatedAt: timestamp, error: "Original failure" },
    ]);
    const migration = new CreateProjectMemberships();
    await migration.up(db);
    const first = await reports.find().sort({ _id: 1 }).toArray();
    expect(first).toEqual([
      expect.objectContaining({ status: "failed", error: "report_generation_disabled", updatedAt: expect.any(Date) }),
      expect.objectContaining({ status: "failed", error: "report_generation_disabled", updatedAt: expect.any(Date) }),
      expect.objectContaining({ status: "completed", updatedAt: timestamp, content: "Stored report" }),
      expect.objectContaining({ status: "failed", updatedAt: timestamp, error: "Original failure" }),
    ]);
    expect(first[0].updatedAt.getTime()).toBeGreaterThan(timestamp.getTime());
    expect(first[1].updatedAt.getTime()).toBeGreaterThan(timestamp.getTime());
    await migration.up(db);
    expect(await reports.find().sort({ _id: 1 }).toArray()).toEqual(first);
    expect(await db.collection("project_memberships").countDocuments()).toBe(0);
  });
});
