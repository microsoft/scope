// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { Collection } from "mongodb";
import { CodebaseStore } from "./codebase-store.js";
import type { CodebaseDocument } from "../types/codebase.js";

type UnknownRecord = Record<string, unknown>;

function matches(doc: CodebaseDocument, filter: UnknownRecord): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    const value = doc[key as keyof CodebaseDocument];
    if (typeof condition === "object" && condition !== null && "$exists" in condition) {
      const exists = value !== undefined;
      if ((condition as { $exists: boolean }).$exists !== exists) return false;
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
      return docs.find((doc) => matches(doc, filter)) ?? null;
    },
    find(filter: UnknownRecord) {
      let result = docs.filter((doc) => matches(doc, filter));
      return {
        sort(sortSpec: UnknownRecord) {
          if (sortSpec.createdAt === -1) {
            result = [...result].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          return this;
        },
        limit() {
          return this;
        },
        async toArray() {
          return result;
        },
      };
    },
    async insertOne(doc: CodebaseDocument) {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    },
    async updateOne(filter: UnknownRecord, update: { $set?: Partial<CodebaseDocument> }) {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(filter: UnknownRecord) {
      const index = docs.findIndex((candidate) => matches(candidate, filter));
      if (index === -1) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    },
    async findOneAndUpdate(
      filter: UnknownRecord,
      update: { $set?: Partial<CodebaseDocument>; $inc?: { revisionCounter?: number } }
    ) {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return null;
      if (update.$inc?.revisionCounter !== undefined) {
        doc.revisionCounter += update.$inc.revisionCounter;
      }
      if (update.$set) Object.assign(doc, update.$set);
      return doc;
    },
  };
}

type CodebaseStorePrivate = {
  ensureUniqueSlug(projectId: string, base: string): Promise<string>;
};

describe("CodebaseStore", () => {
  it("reserves and resolves colliding slugs independently in each project", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);
    const first = await store.create({ projectId: "project-a", name: "Same", sourceType: "archive" });
    const second = await store.create({ projectId: "project-b", name: "Same", sourceType: "archive" });
    expect(first.slug).toBe("same");
    expect(second.slug).toBe("same");
    expect(await store.getBySlug("project-a", "same")).toEqual(first);
    expect(await store.getBySlug("project-b", "same")).toEqual(second);
    expect(await store.getBySlug("project-c", "same")).toBeNull();
  });
  it("creates a codebase with generated metadata and persisted fields", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);

    const created = await store.create({ projectId: "proj-test",
      name: "Pamela Fox Site",
      sourceType: "git",
      source: "pamelafox/site",
      defaultBranch: "main",
      creator: "tester",
    });

    expect(created._id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toMatchObject({
      slug: "pamela-fox-site",
      name: "Pamela Fox Site",
      sourceType: "git",
      source: "pamelafox/site",
      defaultBranch: "main",
      revisionCounter: 0,
      creator: "tester",
    });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(await store.get(created._id)).toEqual(created);
  });

  it("gets by slug, soft-deletes codebases, and excludes deleted entries from list", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);
    const first = await store.create({ projectId: "proj-test", name: "First", sourceType: "archive" });
    const second = await store.create({ projectId: "proj-test", name: "Second", sourceType: "archive" });

    expect(await store.getBySlug("proj-test", first.slug)).toEqual(first);
    expect(await store.softDelete(first._id)).toBe(true);
    expect(await store.getBySlug("proj-test", first.slug)).toBeNull();
    expect(await store.list()).toEqual([second]);
    expect((await store.get(first._id, { includeDeleted: true }))?.deletedAt).toBeInstanceOf(Date);
  });

  it("hard-deletes a codebase, removing it entirely and freeing its slug", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);
    const created = await store.create({ projectId: "proj-test", name: "Orphan", slug: "orphan", sourceType: "archive" });

    expect(await store.hardDelete(created._id)).toBe(true);
    // Fully removed (not just soft-deleted): not retrievable even with includeDeleted.
    expect(await store.get(created._id, { includeDeleted: true })).toBeNull();
    // Slug is freed, so a new codebase can reuse it without suffixing.
    const reused = await store.create({ projectId: "proj-test", name: "Reused", slug: "orphan", sourceType: "archive" });
    expect(reused.slug).toBe("orphan");
    // Deleting a missing codebase reports no deletion.
    expect(await store.hardDelete("missing-codebase")).toBe(false);
  });

  it("allocates revision numbers sequentially and returns null for missing codebases", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);
    const created = await store.create({ projectId: "proj-test", name: "Sequential", sourceType: "archive" });

    await expect(store.allocateRevisionNumber(created._id)).resolves.toBe(1);
    await expect(store.allocateRevisionNumber(created._id)).resolves.toBe(2);
    await expect(store.allocateRevisionNumber("missing-codebase")).resolves.toBeNull();
  });

  it("retries create on an E11000 slug collision and re-derives a unique slug", async () => {
    // Simulate a concurrent create winning the slug race: the first insert with a
    // given slug throws E11000 and the winner's row is recorded, so the retry's
    // ensureUniqueSlug suffixes the slug.
    const docs: CodebaseDocument[] = [];
    let firstInsert = true;
    const collection = {
      async findOne(filter: UnknownRecord) {
        return docs.find((doc) => matches(doc, filter)) ?? null;
      },
      async insertOne(doc: CodebaseDocument) {
        if (firstInsert) {
          firstInsert = false;
          // Another process grabbed this slug between our check and insert.
          docs.push({ ...doc, _id: "rival" });
          throw Object.assign(new Error("E11000 duplicate key error: slug"), {
            code: 11000,
            keyPattern: { slug: 1 },
          });
        }
        docs.push({ ...doc });
        return { insertedId: doc._id };
      },
    };
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);

    const created = await store.create({ projectId: "proj-test", name: "Race", sourceType: "archive" });

    expect(created.slug).toBe("race-2");
    expect(created._id).not.toBe("rival");
  });

  it("propagates a non-slug duplicate-key error without retrying", async () => {
    const collection = {
      async findOne() {
        return null;
      },
      async insertOne() {
        throw Object.assign(new Error("E11000 duplicate key error: _id"), {
          code: 11000,
          keyPattern: { _id: 1 },
        });
      },
    };
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);

    await expect(store.create({ projectId: "proj-test", name: "Boom", sourceType: "archive" })).rejects.toThrow(/E11000/);
  });
});
