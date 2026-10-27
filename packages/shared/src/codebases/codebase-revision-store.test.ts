// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { Collection } from "mongodb";
import { CodebaseStore } from "./codebase-store.js";
import { CodebaseRevisionStore, type CreateCodebaseRevisionInput } from "./codebase-revision-store.js";
import type { CodebaseDocument, CodebaseRevisionDocument } from "../types/codebase.js";

type UnknownRecord = Record<string, unknown>;

function matches<T extends UnknownRecord>(doc: T, filter: UnknownRecord): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$or" && Array.isArray(condition)) {
      if (!condition.some((sub) => matches(doc, sub as UnknownRecord))) return false;
      continue;
    }
    const value = doc[key];
    if (typeof condition === "object" && condition !== null && "$exists" in condition) {
      const exists = value !== undefined;
      if ((condition as { $exists: boolean }).$exists !== exists) return false;
      continue;
    }
    if (typeof condition === "object" && condition !== null && "$lt" in condition) {
      if (typeof value !== "number") return false;
      if (!(value < (condition as { $lt: number }).$lt)) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function makeCodebaseCollection(seed: CodebaseDocument[] = []) {
  const docs = seed.map((doc) => ({ ...doc }));
  return {
    docs,
    async findOne(filter: UnknownRecord) {
      return docs.find((doc) => matches(doc as unknown as UnknownRecord, filter)) ?? null;
    },
    find(filter: UnknownRecord) {
      const result = docs.filter((doc) => matches(doc as unknown as UnknownRecord, filter));
      return { sort: () => ({ toArray: async () => result }) };
    },
    async insertOne(doc: CodebaseDocument) {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    },
    async updateOne(filter: UnknownRecord, update: { $set?: Partial<CodebaseDocument> }) {
      const doc = docs.find((candidate) => matches(candidate as unknown as UnknownRecord, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(
      filter: UnknownRecord,
      update: { $set?: Partial<CodebaseDocument>; $inc?: { revisionCounter?: number } }
    ) {
      const doc = docs.find((candidate) => matches(candidate as unknown as UnknownRecord, filter));
      if (!doc) return null;
      if (update.$inc?.revisionCounter !== undefined) doc.revisionCounter += update.$inc.revisionCounter;
      if (update.$set) Object.assign(doc, update.$set);
      return doc;
    },
  };
}

function makeRevisionCollection(seed: CodebaseRevisionDocument[] = []) {
  const docs = seed.map((doc) => ({ ...doc }));
  return {
    docs,
    async findOne(filter: UnknownRecord) {
      return docs.find((doc) => matches(doc as unknown as UnknownRecord, filter)) ?? null;
    },
    find(filter: UnknownRecord) {
      let result = docs.filter((doc) => matches(doc as unknown as UnknownRecord, filter));
      return {
        sort(sortSpec: UnknownRecord) {
          if (sortSpec.revisionNumber === -1) {
            result = [...result].sort((a, b) => b.revisionNumber - a.revisionNumber);
          }
          return this;
        },
        limit(limitValue: number) {
          result = result.slice(0, limitValue);
          return this;
        },
        async toArray() {
          return result;
        },
      };
    },
    async insertOne(doc: CodebaseRevisionDocument) {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    },
    async deleteMany(filter: UnknownRecord) {
      const before = docs.length;
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        if (matches(docs[index] as unknown as UnknownRecord, filter)) docs.splice(index, 1);
      }
      return { deletedCount: before - docs.length };
    },
    async updateMany(filter: UnknownRecord, update: { $set?: Partial<CodebaseRevisionDocument> }) {
      let modifiedCount = 0;
      for (const doc of docs) {
        if (matches(doc as unknown as UnknownRecord, filter)) {
          if (update.$set) Object.assign(doc, update.$set);
          modifiedCount += 1;
        }
      }
      return { matchedCount: modifiedCount, modifiedCount };
    },
  };
}

function revisionInput(codebase: CodebaseDocument): CreateCodebaseRevisionInput {
  return {
    codebaseId: codebase._id,
    slug: codebase.slug,
    sourceType: "archive",
    originalFilename: "archive.tar.gz",
    archiveUrl: "https://blob.test/archive.tar.gz",
    resolvedAt: new Date("2024-01-01T00:00:00Z"),
  };
}

async function makeStores() {
  const codebaseCollection = makeCodebaseCollection();
  const codebaseStore = new CodebaseStore(codebaseCollection as unknown as Collection<CodebaseDocument>);
  const revisionCollection = makeRevisionCollection();
  const revisionStore = new CodebaseRevisionStore(
    revisionCollection as unknown as Collection<CodebaseRevisionDocument>,
    codebaseStore
  );
  const codebase = await codebaseStore.create({ projectId: "proj-test", name: "Pamela Fox Site", sourceType: "archive" });
  return { codebaseStore, revisionStore, codebase, revisions: revisionCollection.docs };
}

describe("CodebaseRevisionStore", () => {
  it("creates purely incremental revisions with distinct ids and refs", async () => {
    const { revisionStore, codebase, revisions } = await makeStores();
    const input = revisionInput(codebase);

    const first = await revisionStore.createRevision(input);
    const second = await revisionStore.createRevision(input);

    expect(first).toMatchObject({ revisionNumber: 1, ref: "pamela-fox-site@r1" });
    expect(second).toMatchObject({ revisionNumber: 2, ref: "pamela-fox-site@r2" });
    expect(first._id).not.toBe(second._id);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toEqual(first);
  });

  it("uses a provided revision id", async () => {
    const { revisionStore, codebase } = await makeStores();

    const created = await revisionStore.createRevision(revisionInput(codebase), { id: "fixed-uuid" });

    expect(created._id).toBe("fixed-uuid");
  });

  it("retrieves revisions by ref, latest revision, and newest-first list", async () => {
    const { revisionStore, codebase } = await makeStores();
    const first = await revisionStore.createRevision(revisionInput(codebase));
    const second = await revisionStore.createRevision(revisionInput(codebase));

    await expect(revisionStore.getByRef("proj-test", "pamela-fox-site@r1")).resolves.toEqual(first);
    await expect(revisionStore.getByRef("another-project", "pamela-fox-site@r1")).resolves.toBeNull();
    await expect(revisionStore.getLatest(codebase._id)).resolves.toEqual(second);
    await expect(revisionStore.listByCodebase(codebase._id)).resolves.toEqual([second, first]);
  });

  it("soft-deletes revisions by codebase: hidden from listings but still resolvable by id/ref", async () => {
    const { revisionStore, codebase } = await makeStores();
    const first = await revisionStore.createRevision(revisionInput(codebase));
    const second = await revisionStore.createRevision(revisionInput(codebase));

    const count = await revisionStore.softDeleteByCodebase(codebase._id);
    expect(count).toBe(2);

    // Listings exclude soft-deleted revisions by default.
    await expect(revisionStore.listByCodebase(codebase._id)).resolves.toEqual([]);
    await expect(revisionStore.getLatest(codebase._id)).resolves.toBeNull();

    // includeDeleted brings them back for listings.
    await expect(revisionStore.listByCodebase(codebase._id, { includeDeleted: true })).resolves.toHaveLength(2);
    await expect(revisionStore.getLatest(codebase._id, { includeDeleted: true })).resolves.toMatchObject({
      revisionNumber: 2,
    });

    // Direct id/ref/number lookups still resolve so runs keep working.
    await expect(revisionStore.get(first._id)).resolves.toMatchObject({ _id: first._id });
    await expect(revisionStore.getByRef("proj-test", second.ref)).resolves.toMatchObject({ _id: second._id });
    await expect(revisionStore.getByNumber(codebase._id, 1)).resolves.toMatchObject({ _id: first._id });
  });

  it("advances latestRevisionId to the newest revision on create", async () => {
    const { revisionStore, codebase, codebaseStore } = await makeStores();
    const first = await revisionStore.createRevision(revisionInput(codebase));
    let cb = await codebaseStore.get(codebase._id);
    expect(cb?.latestRevisionId).toBe(first._id);
    expect(cb?.latestRevisionNumber).toBe(1);

    const second = await revisionStore.createRevision(revisionInput(codebase));
    cb = await codebaseStore.get(codebase._id);
    expect(cb?.latestRevisionId).toBe(second._id);
    expect(cb?.latestRevisionNumber).toBe(2);
  });

  it("does not regress the latestRevisionId pointer when an older revision is set after a newer one", async () => {
    const { revisionStore, codebase, codebaseStore } = await makeStores();
    // Simulate a concurrency race: r2 created, then a slower writer for r1 tries to
    // set the pointer back. The guard must keep the pointer at the newer revision.
    const r1 = await revisionStore.createRevision(revisionInput(codebase));
    const r2 = await revisionStore.createRevision(revisionInput(codebase));

    await codebaseStore.setLatestRevision(codebase._id, r1._id, r1.revisionNumber);

    const cb = await codebaseStore.get(codebase._id);
    expect(cb?.latestRevisionId).toBe(r2._id);
    expect(cb?.latestRevisionNumber).toBe(2);
  });

  it("throws when the parent codebase does not exist", async () => {
    const codebaseCollection = makeCodebaseCollection();
    const codebaseStore = new CodebaseStore(codebaseCollection as unknown as Collection<CodebaseDocument>);
    const revisionCollection = makeRevisionCollection();
    const revisionStore = new CodebaseRevisionStore(
      revisionCollection as unknown as Collection<CodebaseRevisionDocument>,
      codebaseStore
    );

    await expect(
      revisionStore.createRevision({
        codebaseId: "missing",
        slug: "missing",
        sourceType: "archive",
        archiveUrl: "https://blob.test/archive.tar.gz",
        resolvedAt: new Date(),
      })
    ).rejects.toThrow(/not found/);
  });
});
