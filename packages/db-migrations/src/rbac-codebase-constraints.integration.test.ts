// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient, type Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkMigrations, resetMigrationCheckCache } from "./check-migrations.js";
import { CreateProjectMemberships } from "./migrations/031-create-project-memberships.js";
import { REQUIRED_MIGRATIONS } from "./required-migrations.js";

const uri = process.env.AUTH_TEST_MONGO_URI;
const execute = promisify(execFile);

describe.skipIf(!uri)("RBAC release without the deferred codebase migration", () => {
  let client: MongoClient;
  let db: Db;

  beforeEach(async () => {
    client = await MongoClient.connect(uri!);
    db = client.db(`rbac_codebase_test_${randomUUID().replaceAll("-", "")}`);
    resetMigrationCheckCache();
  });

  afterEach(async () => {
    await db.dropDatabase();
    await client.close();
    resetMigrationCheckCache();
  });

  it("runs the actual CLI through 031, reruns safely and preserves legacy constraints", async () => {
    const run = () => execute("pnpm", ["exec", "tsx", "src/migrate.ts", "up"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, MONGODB_URI: uri, MONGODB_DATABASE: db.databaseName },
      timeout: 60_000,
    });
    await run();
    const files = (await db.collection("_migrations").find().toArray()).map(row => row.file);
    expect(files.sort()).toEqual([...REQUIRED_MIGRATIONS].sort());
    expect(files).not.toContain("032-scope-codebase-uniqueness.ts");
    expect(await checkMigrations(db)).toMatchObject({ ready: true, pending: [], totalApplied: 31 });

    const codebases = db.collection("codebases");
    const revisions = db.collection("codebase-revisions");
    const before = await Promise.all([codebases.listIndexes().toArray(), revisions.listIndexes().toArray()]);
    expect(before[0]).toEqual(expect.arrayContaining([expect.objectContaining({ key: { slug: 1 }, unique: true })]));
    expect(before[1]).toEqual(expect.arrayContaining([expect.objectContaining({ key: { ref: 1 }, unique: true })]));
    await run();
    expect(await Promise.all([codebases.listIndexes().toArray(), revisions.listIndexes().toArray()])).toEqual(before);
    expect(await db.collection("_migrations").countDocuments()).toBe(31);

    const created = await Promise.allSettled([
      codebases.insertOne({ projectId: "a", slug: "concurrent" }),
      codebases.insertOne({ projectId: "a", slug: "concurrent" }),
    ]);
    expect(created.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(created.filter(result => result.status === "rejected")).toHaveLength(1);
    // A legacy global index still prevents reuse in another project (#1521).
    await expect(codebases.insertOne({ projectId: "b", slug: "concurrent" }))
      .rejects.toMatchObject({ code: 11000 });
    const attempts = await Promise.allSettled([
      revisions.insertOne({ projectId: "a", ref: "concurrent@r1" }),
      revisions.insertOne({ projectId: "a", ref: "concurrent@r1" }),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("retains previously installed project-local uniqueness when applying RBAC", async () => {
    const codebases = db.collection("codebases");
    const revisions = db.collection("codebase-revisions");
    await codebases.createIndex({ projectId: 1, slug: 1 }, { name: "uniq_project_codebase_slug", unique: true });
    await revisions.createIndex({ projectId: 1, ref: 1 }, { name: "uniq_project_codebase_ref", unique: true });
    const before = await Promise.all([codebases.listIndexes().toArray(), revisions.listIndexes().toArray()]);
    await new CreateProjectMemberships().up(db);
    expect(await Promise.all([codebases.listIndexes().toArray(), revisions.listIndexes().toArray()])).toEqual(before);

    const concurrent = await Promise.allSettled([
      codebases.insertOne({ projectId: "a", slug: "shared" }),
      codebases.insertOne({ projectId: "a", slug: "shared" }),
      codebases.insertOne({ projectId: "b", slug: "shared" }),
    ]);
    expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(concurrent.filter(result => result.status === "rejected")).toHaveLength(1);
    const attempts = await Promise.allSettled([
      revisions.insertOne({ projectId: "a", ref: "shared@r1" }),
      revisions.insertOne({ projectId: "a", ref: "shared@r1" }),
      revisions.insertOne({ projectId: "b", ref: "shared@r1" }),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("does not claim RBAC installs missing codebase uniqueness", async () => {
    await new CreateProjectMemberships().up(db);
    for (const [name, key] of [["codebases", "slug"], ["codebase-revisions", "ref"]] as const) {
      const collection = db.collection(name);
      await Promise.all([
        collection.insertOne({ projectId: "a", [key]: "same" }),
        collection.insertOne({ projectId: "a", [key]: "same" }),
      ]);
      expect(await collection.countDocuments({ projectId: "a", [key]: "same" })).toBe(2);
      expect((await collection.listIndexes().toArray()).filter(index => index.unique)).toEqual([]);
    }
  });
});
