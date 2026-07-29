// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskPromptStore } from "./task-prompt-store.js";
import { computeTaskPromptId } from "./task-prompt-id.js";
import type { TaskPromptDocument, PromptFeatureResult } from "@scope/core";

// ── Mock Collection ──────────────────────────────────────────────────────────
// Simulates a MongoDB collection in-memory for deterministic unit testing.

function createMockCollection() {
  const docs = new Map<string, TaskPromptDocument>();

  const mockCursor = (results: TaskPromptDocument[]) => ({
    _results: results,
    sort() { return this; },
    skip(n: number) { this._results = this._results.slice(n); return this; },
    limit(n: number) { this._results = this._results.slice(0, n); return this; },
    toArray() { return Promise.resolve(this._results); },
  });

  return {
    _docs: docs,

    findOne: vi.fn(async (filter: any) => {
      if (filter._id) {
        const doc = docs.get(filter._id);
        if (!doc) return null;
        // Check deletedAt filter
        if (filter.deletedAt && filter.deletedAt.$exists === false && doc.deletedAt) {
          return null;
        }
        return { ...doc };
      }
      return null;
    }),

    insertOne: vi.fn(async (doc: any) => {
      docs.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    }),

    updateOne: vi.fn(async (filter: any, update: any) => {
      const doc = docs.get(filter._id);
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      // Check deletedAt filter if present
      if (filter.deletedAt && filter.deletedAt.$exists === false && doc.deletedAt) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      if (update.$unset) {
        for (const key of Object.keys(update.$unset)) {
          delete (doc as any)[key];
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    }),

    countDocuments: vi.fn(async (filter: any) => {
      let count = 0;
      for (const doc of docs.values()) {
        if (filter.deletedAt?.$exists === false && doc.deletedAt) continue;
        if (filter.text?.$regex) {
          const regex = new RegExp(filter.text.$regex, filter.text.$options);
          if (!regex.test(doc.text)) continue;
        }
        count++;
      }
      return count;
    }),

    find: vi.fn((filter: any) => {
      const results: TaskPromptDocument[] = [];
      for (const doc of docs.values()) {
        if (filter.deletedAt?.$exists === false && doc.deletedAt) continue;
        if (filter.text?.$regex) {
          const regex = new RegExp(filter.text.$regex, filter.text.$options);
          if (!regex.test(doc.text)) continue;
        }
        results.push({ ...doc });
      }
      return mockCursor(results);
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TaskPromptStore", () => {
  let col: ReturnType<typeof createMockCollection>;
  let store: TaskPromptStore;

  beforeEach(() => {
    col = createMockCollection();
    store = new TaskPromptStore(col as any);
  });

  // -- findOrCreate ---------------------------------------------------------

  describe("findOrCreate", () => {
    it("creates a new task prompt", async () => {
      const doc = await store.findOrCreate("Hello world");
      const expectedId = computeTaskPromptId("Hello world");
      expect(doc._id).toBe(expectedId);
      expect(doc.text).toBe("Hello world");
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.deletedAt).toBeUndefined();
    });

    it("is idempotent — returns existing doc on second call", async () => {
      const a = await store.findOrCreate("Hello world");
      const b = await store.findOrCreate("Hello world");
      expect(a._id).toBe(b._id);
      expect(col.insertOne).toHaveBeenCalledTimes(1);
    });

    it("trims whitespace", async () => {
      const a = await store.findOrCreate("  foo  ");
      expect(a.text).toBe("foo");
      expect(a._id).toBe(computeTaskPromptId("foo"));
    });

    it("revives a soft-deleted document", async () => {
      const doc = await store.findOrCreate("deleted prompt");
      await store.delete(doc._id);

      const revived = await store.findOrCreate("deleted prompt");
      expect(revived._id).toBe(doc._id);
      expect(revived.deletedAt).toBeUndefined();
    });
  });

  // -- get ------------------------------------------------------------------

  describe("get", () => {
    it("returns null for non-existent ID", async () => {
      const result = await store.get("nonexistent");
      expect(result).toBeNull();
    });

    it("returns the document by ID", async () => {
      const created = await store.findOrCreate("test prompt");
      const result = await store.get(created._id);
      expect(result).not.toBeNull();
      expect(result!.text).toBe("test prompt");
    });

    it("returns null for soft-deleted documents", async () => {
      const created = await store.findOrCreate("to be deleted");
      await store.delete(created._id);
      const result = await store.get(created._id);
      expect(result).toBeNull();
    });
  });

  // -- getByText ------------------------------------------------------------

  describe("getByText", () => {
    it("finds a document by text content", async () => {
      await store.findOrCreate("find me");
      const result = await store.getByText("find me");
      expect(result).not.toBeNull();
      expect(result!.text).toBe("find me");
    });

    it("returns null for unknown text", async () => {
      const result = await store.getByText("unknown text");
      expect(result).toBeNull();
    });
  });

  // -- delete ---------------------------------------------------------------

  describe("delete", () => {
    it("soft-deletes a document", async () => {
      const doc = await store.findOrCreate("deletion target");
      await store.delete(doc._id);
      const result = await store.get(doc._id);
      expect(result).toBeNull();
    });

    it("throws when deleting non-existent ID", async () => {
      await expect(store.delete("nonexistent")).rejects.toThrow(
        "Task prompt 'nonexistent' not found",
      );
    });
  });

  // -- getAll ---------------------------------------------------------------

  describe("getAll", () => {
    it("returns empty list when no documents exist", async () => {
      const { items, total } = await store.getAll();
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });

    it("returns all active documents", async () => {
      await store.findOrCreate("first");
      await store.findOrCreate("second");
      const { items, total } = await store.getAll();
      expect(total).toBe(2);
      expect(items).toHaveLength(2);
    });

    it("excludes soft-deleted documents", async () => {
      const doc = await store.findOrCreate("will delete");
      await store.findOrCreate("will keep");
      await store.delete(doc._id);
      const { items, total } = await store.getAll();
      expect(total).toBe(1);
      expect(items[0].text).toBe("will keep");
    });

    it("supports search filter", async () => {
      await store.findOrCreate("Azure deployment");
      await store.findOrCreate("React frontend");
      const { items, total } = await store.getAll({ search: "azure" });
      expect(total).toBe(1);
      expect(items[0].text).toBe("Azure deployment");
    });
  });

  // -- attachFeatures -------------------------------------------------------

  describe("attachFeatures", () => {
    it("attaches features to a task prompt", async () => {
      const doc = await store.findOrCreate("feature target");
      const features: PromptFeatureResult[] = [
        { featureId: "has_node", detected: true, evaluated: true },
        { featureId: "has_react", detected: false, evaluated: true },
      ];

      const updated = await store.attachFeatures(doc._id, features);
      expect(updated.features).toEqual(features);
      expect(updated.featuresExtractedAt).toBeInstanceOf(Date);
    });

    it("throws when attaching to non-existent ID", async () => {
      await expect(
        store.attachFeatures("nonexistent", []),
      ).rejects.toThrow("Task prompt 'nonexistent' not found");
    });

    it("overwrites previous features", async () => {
      const doc = await store.findOrCreate("overwrite target");
      const v1: PromptFeatureResult[] = [{ featureId: "a", detected: true, evaluated: true }];
      const v2: PromptFeatureResult[] = [{ featureId: "b", detected: false, evaluated: true }];

      await store.attachFeatures(doc._id, v1);
      const updated = await store.attachFeatures(doc._id, v2);
      expect(updated.features).toEqual(v2);
    });
  });
});
