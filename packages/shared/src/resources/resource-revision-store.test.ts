// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { Collection } from "mongodb";
import { ResourceStore } from "./resource-store.js";
import { ResourceRevisionStore, type CreateResourceRevisionStoreInput } from "./resource-revision-store.js";
import type { ResourceDocument, ResourceRevisionDocument } from "../types/resource.js";

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

function makeResourceCollection(seed: ResourceDocument[] = []) {
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
          if (sortSpec.createdAt === -1) {
            result = [...result].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          return this;
        },
        async toArray() {
          return result;
        },
      };
    },
    async insertOne(doc: ResourceDocument) {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    },
    async deleteOne(filter: UnknownRecord) {
      const index = docs.findIndex((candidate) => matches(candidate as unknown as UnknownRecord, filter));
      if (index === -1) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    },
    async updateOne(filter: UnknownRecord, update: { $set?: Partial<ResourceDocument> }) {
      const doc = docs.find((candidate) => matches(candidate as unknown as UnknownRecord, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(
      filter: UnknownRecord,
      update: { $set?: Partial<ResourceDocument>; $inc?: { revisionCounter?: number } }
    ) {
      const doc = docs.find((candidate) => matches(candidate as unknown as UnknownRecord, filter));
      if (!doc) return null;
      if (update.$inc?.revisionCounter !== undefined) doc.revisionCounter += update.$inc.revisionCounter;
      if (update.$set) Object.assign(doc, update.$set);
      return { ...doc };
    },
  };
}

function makeRevisionCollection(seed: ResourceRevisionDocument[] = []) {
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
    async insertOne(doc: ResourceRevisionDocument) {
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
    async updateMany(filter: UnknownRecord, update: { $set?: Partial<ResourceRevisionDocument> }) {
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

function revisionInput(resource: ResourceDocument): CreateResourceRevisionStoreInput {
  return {
    resourceId: resource._id,
    slug: resource.slug,
    setup: { sh: "echo ok" },
    exports: ["URL"],
    contentSha256: "sha",
  };
}

async function makeStores() {
  const resourceCollection = makeResourceCollection();
  const resourceStore = new ResourceStore(resourceCollection as unknown as Collection<ResourceDocument>);
  const revisionCollection = makeRevisionCollection();
  const revisionStore = new ResourceRevisionStore(
    revisionCollection as unknown as Collection<ResourceRevisionDocument>,
    resourceStore
  );
  const resource = await resourceStore.create({ projectId: "proj-test", name: "GitHub Simulator" });
  return { resourceStore, revisionStore, resource, revisions: revisionCollection.docs };
}

describe("ResourceRevisionStore", () => {
  it("allocates distinct sequential revision numbers under concurrent creates", async () => {
    const { revisionStore, resource, resourceStore, revisions } = await makeStores();

    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        revisionStore.createRevision({
          ...revisionInput(resource),
          contentSha256: `sha-${index}`,
        })
      )
    );

    expect(created.map((revision) => revision.revisionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(created.map((revision) => revision.ref)).size).toBe(10);
    expect(revisions).toHaveLength(10);
    const fresh = await resourceStore.get(resource._id);
    expect(fresh?.revisionCounter).toBe(10);
    expect(fresh?.latestRevisionNumber).toBe(10);
  });

  it("retrieves by project-scoped ref, latest revision, and newest-first list", async () => {
    const { revisionStore, resource } = await makeStores();
    const first = await revisionStore.createRevision(revisionInput(resource));
    const second = await revisionStore.createRevision({ ...revisionInput(resource), contentSha256: "sha-2" });

    await expect(revisionStore.getByRef(resource.projectId, "github-simulator@r1")).resolves.toEqual(first);
    await expect(revisionStore.getLatest(resource._id)).resolves.toEqual(second);
    await expect(revisionStore.listByResource(resource._id)).resolves.toEqual([second, first]);
  });

  it("soft-deletes revisions by resource: hidden from listings but still resolvable by id/ref/number", async () => {
    const { revisionStore, resource } = await makeStores();
    const first = await revisionStore.createRevision(revisionInput(resource));
    const second = await revisionStore.createRevision({ ...revisionInput(resource), contentSha256: "sha-2" });

    await expect(revisionStore.softDeleteByResource(resource._id)).resolves.toBe(2);
    await expect(revisionStore.listByResource(resource._id)).resolves.toEqual([]);
    await expect(revisionStore.getLatest(resource._id)).resolves.toBeNull();
    await expect(revisionStore.getLatest(resource._id, { includeDeleted: true })).resolves.toMatchObject({ revisionNumber: 2 });
    await expect(revisionStore.get(first._id)).resolves.toMatchObject({ _id: first._id });
    await expect(revisionStore.getByRef(resource.projectId, second.ref)).resolves.toMatchObject({ _id: second._id });
    await expect(revisionStore.getByNumber(resource._id, 1)).resolves.toMatchObject({ _id: first._id });
  });

  it("does not regress the latest pointer when an older revision is set after a newer one", async () => {
    const { revisionStore, resource, resourceStore } = await makeStores();
    const r1 = await revisionStore.createRevision(revisionInput(resource));
    const r2 = await revisionStore.createRevision({ ...revisionInput(resource), contentSha256: "sha-2" });

    await resourceStore.setLatestRevision(resource._id, r1._id, r1.revisionNumber);

    const fresh = await resourceStore.get(resource._id);
    expect(fresh?.latestRevisionId).toBe(r2._id);
    expect(fresh?.latestRevisionNumber).toBe(2);
  });
});
