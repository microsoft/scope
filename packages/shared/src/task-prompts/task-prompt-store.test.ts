// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskPromptStore } from "./task-prompt-store.js";
import { computeTaskPromptId, computePromptId } from "./task-prompt-id.js";
import type { TaskPromptDocument, PromptFeatureResult } from "../types/types.js";

/** Project scope used across these unit tests. */
const PID = "proj-test";

// ── Mock Collection ──────────────────────────────────────────────────────────
// Simulates a MongoDB collection in-memory for deterministic unit testing.
// Matches the subset of filters the store issues: `_id`, `projectId`, `keyId`,
// `type`, `deletedAt.$exists`, `text.$regex`, and the `$or` type clause.

function createMockCollection() {
  const docs = new Map<string, TaskPromptDocument>();

  const mockCursor = (results: TaskPromptDocument[]) => ({
    _results: results,
    sort() { return this; },
    skip(n: number) { this._results = this._results.slice(n); return this; },
    limit(n: number) { this._results = this._results.slice(0, n); return this; },
    toArray() { return Promise.resolve(this._results); },
  });

  const matches = (doc: TaskPromptDocument, filter: any): boolean => {
    if (filter._id !== undefined && doc._id !== filter._id) return false;
    if (filter.projectId !== undefined && doc.projectId !== filter.projectId) return false;
    if (filter.keyId !== undefined && doc.keyId !== filter.keyId) return false;
    if (filter.deletedAt?.$exists === false && doc.deletedAt) return false;
    if (filter.deletedAt?.$exists === true && !doc.deletedAt) return false;
    if (filter.text?.$regex) {
      const regex = new RegExp(filter.text.$regex, filter.text.$options);
      if (!regex.test(doc.text ?? "")) return false;
    }
    if (!matchesType(filter, doc)) return false;
    return true;
  };

  return {
    _docs: docs,

    findOne: vi.fn(async (filter: any) => {
      for (const doc of docs.values()) {
        if (matches(doc, filter)) return { ...doc };
      }
      return null;
    }),

    insertOne: vi.fn(async (doc: any) => {
      docs.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    }),

    updateOne: vi.fn(async (filter: any, update: any) => {
      let target: TaskPromptDocument | undefined;
      for (const doc of docs.values()) {
        if (matches(doc, filter)) { target = doc; break; }
      }
      if (!target) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(target, update.$set);
      if (update.$unset) {
        for (const key of Object.keys(update.$unset)) delete (target as any)[key];
      }
      return { matchedCount: 1, modifiedCount: 1 };
    }),

    countDocuments: vi.fn(async (filter: any) => {
      let count = 0;
      for (const doc of docs.values()) {
        if (matches(doc, filter)) count++;
      }
      return count;
    }),

    find: vi.fn((filter: any) => {
      const results: TaskPromptDocument[] = [];
      for (const doc of docs.values()) {
        if (matches(doc, filter)) results.push({ ...doc });
      }
      return mockCursor(results);
    }),
  };
}

/** Replicates the store's `$or`/`type` filter against an in-memory doc. */
function matchesType(filter: any, doc: TaskPromptDocument): boolean {
  if (filter.$or) {
    return filter.$or.some((clause: any) => {
      if (clause.type?.$exists === false) return doc.type === undefined;
      return doc.type === clause.type;
    });
  }
  if (filter.type !== undefined) {
    const cond = filter.type;
    if (cond && typeof cond === "object") {
      // `$nin` (and `$in`) treat a missing `type` as `undefined` — mirrors Mongo,
      // so legacy untyped docs stay visible under the default `$nin` filter.
      if (Array.isArray(cond.$nin)) return !cond.$nin.includes(doc.type);
      if (Array.isArray(cond.$in)) return cond.$in.includes(doc.type);
    }
    return doc.type === cond;
  }
  return true;
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
    it("creates a new task prompt with a fresh _id and content-hash keyId", async () => {
      const doc = await store.findOrCreate(PID, "Hello world");
      expect(doc.keyId).toBe(computeTaskPromptId("Hello world"));
      expect(doc._id).not.toBe(doc.keyId); // fresh UUID, not the content hash
      expect(doc.projectId).toBe(PID);
      expect(doc.text).toBe("Hello world");
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.deletedAt).toBeUndefined();
    });

    it("is idempotent within a project — returns existing doc on second call", async () => {
      const a = await store.findOrCreate(PID, "Hello world");
      const b = await store.findOrCreate(PID, "Hello world");
      expect(a._id).toBe(b._id);
      expect(col.insertOne).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent identical creates within one store", async () => {
      const [a, b, c] = await Promise.all([
        store.findOrCreate(PID, "concurrent prompt"),
        store.findOrCreate(PID, "concurrent prompt"),
        store.findOrCreate(PID, "concurrent prompt"),
      ]);

      expect(a._id).toBe(b._id);
      expect(b._id).toBe(c._id);
      expect(col.insertOne).toHaveBeenCalledTimes(1);
    });

    it("creates distinct per-project copies for identical text (same keyId, distinct _id)", async () => {
      const a = await store.findOrCreate("project-a", "shared prompt");
      const b = await store.findOrCreate("project-b", "shared prompt");
      expect(a.keyId).toBe(b.keyId); // same content hash
      expect(a._id).not.toBe(b._id); // distinct documents
      expect(a.projectId).toBe("project-a");
      expect(b.projectId).toBe("project-b");
      expect(col.insertOne).toHaveBeenCalledTimes(2);
    });

    it("trims whitespace", async () => {
      const a = await store.findOrCreate(PID, "  foo  ");
      expect(a.text).toBe("foo");
      expect(a.keyId).toBe(computeTaskPromptId("foo"));
    });

    it("revives a soft-deleted document", async () => {
      const doc = await store.findOrCreate(PID, "deleted prompt");
      await store.delete(doc._id);

      const revived = await store.findOrCreate(PID, "deleted prompt");
      expect(revived._id).toBe(doc._id);
      expect(revived.deletedAt).toBeUndefined();
    });

    it("namespaces non-task types into a distinct keyId", async () => {
      const task = await store.findOrCreate(PID, "same text");
      const agents = await store.findOrCreate(PID, "same text", "agents.md");
      expect(agents.keyId).not.toBe(task.keyId);
      expect(agents.keyId).toBe(computePromptId("agents.md", "same text"));
      expect(agents.type).toBe("agents.md");
    });

    it("keeps task keyIds backward-compatible (unchanged by type arg)", async () => {
      const a = await store.findOrCreate(PID, "hello");
      const b = await store.findOrCreate(PID, "hello", "select");
      expect(a._id).toBe(b._id);
      expect(a.keyId).toBe(computeTaskPromptId("hello"));
    });
  });

  // -- size-based storage ---------------------------------------------------

  describe("size-based storage", () => {
    function createMockBlob() {
      const blobs = new Map<string, string>();
      return {
        store: blobs,
        uploadText: vi.fn(async (name: string, text: string) => {
          blobs.set(name, text);
          return `https://acct.blob/snapshots/${name}`;
        }),
        downloadBlobToBuffer: vi.fn(async (name: string) => {
          const v = blobs.get(name);
          if (v === undefined) throw new Error(`blob ${name} not found`);
          return Buffer.from(v, "utf-8");
        }),
      };
    }

    it("stores small bodies inline and never touches blob", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 1024);
      const doc = await s.findOrCreate(PID, "tiny");
      expect(doc.text).toBe("tiny");
      expect(doc.contentBlobUrl).toBeUndefined();
      expect(blob.uploadText).not.toHaveBeenCalled();
    });

    it("uploads over-threshold bodies to blob on a create miss", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 16);
      const big = "x".repeat(64);
      const doc = await s.findOrCreate(PID, big, "agents.md");
      expect(doc.text).toBeUndefined();
      expect(doc.contentBlobUrl).toContain(`prompts/${doc._id}.txt`);
      expect(blob.uploadText).toHaveBeenCalledTimes(1);
    });

    it("skips the upload on a hit (idempotent)", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 16);
      const big = "y".repeat(64);
      await s.findOrCreate(PID, big, "agents.md");
      await s.findOrCreate(PID, big, "agents.md");
      expect(blob.uploadText).toHaveBeenCalledTimes(1);
    });

    it("resolvePromptText returns inline text without blob access", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 1024);
      const doc = await s.findOrCreate(PID, "inline body");
      expect(await s.resolvePromptText(doc)).toBe("inline body");
      expect(blob.downloadBlobToBuffer).not.toHaveBeenCalled();
    });

    it("resolvePromptText downloads blob-backed bodies", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 16);
      const big = "z".repeat(64);
      const doc = await s.findOrCreate(PID, big, "agents.md");
      expect(await s.resolvePromptText(doc)).toBe(big);
      expect(blob.downloadBlobToBuffer).toHaveBeenCalledTimes(1);
    });

    it("rejects bodies over the hard max size", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 16);
      const huge = "a".repeat(256 * 1024 + 1);
      await expect(s.findOrCreate(PID, huge)).rejects.toThrow(/maximum/);
    });

    it("throws when an over-threshold body has no blob storage configured", async () => {
      const s = new TaskPromptStore(col as any, undefined, 16);
      await expect(s.findOrCreate(PID, "b".repeat(64))).rejects.toThrow(/BlobStorage/);
    });
  });

  // -- get ------------------------------------------------------------------

  describe("get", () => {
    it("returns null for non-existent ID", async () => {
      const result = await store.get("nonexistent");
      expect(result).toBeNull();
    });

    it("returns the document by ID", async () => {
      const created = await store.findOrCreate(PID, "test prompt");
      const result = await store.get(created._id);
      expect(result).not.toBeNull();
      expect(result!.text).toBe("test prompt");
    });

    it("returns null for soft-deleted documents", async () => {
      const created = await store.findOrCreate(PID, "to be deleted");
      await store.delete(created._id);
      const result = await store.get(created._id);
      expect(result).toBeNull();
    });
  });

  // -- getByText ------------------------------------------------------------

  describe("getByText", () => {
    it("finds a document by text content within a project", async () => {
      await store.findOrCreate(PID, "find me");
      const result = await store.getByText(PID, "find me");
      expect(result).not.toBeNull();
      expect(result!.text).toBe("find me");
    });

    it("returns null for unknown text", async () => {
      const result = await store.getByText(PID, "unknown text");
      expect(result).toBeNull();
    });

    it("does not find another project's prompt", async () => {
      await store.findOrCreate("project-a", "scoped text");
      const result = await store.getByText("project-b", "scoped text");
      expect(result).toBeNull();
    });
  });

  // -- delete ---------------------------------------------------------------

  describe("delete", () => {
    it("soft-deletes a document", async () => {
      const doc = await store.findOrCreate(PID, "deletion target");
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
      await store.findOrCreate(PID, "first");
      await store.findOrCreate(PID, "second");
      const { items, total } = await store.getAll();
      expect(total).toBe(2);
      expect(items).toHaveLength(2);
    });

    it("scopes to a single project when projectId is given", async () => {
      await store.findOrCreate("project-a", "a-only");
      await store.findOrCreate("project-b", "b-only");
      const { items, total } = await store.getAll({ projectId: "project-a" });
      expect(total).toBe(1);
      expect(items[0].text).toBe("a-only");
    });

    it("excludes soft-deleted documents", async () => {
      const doc = await store.findOrCreate(PID, "will delete");
      await store.findOrCreate(PID, "will keep");
      await store.delete(doc._id);
      const { items, total } = await store.getAll();
      expect(total).toBe(1);
      expect(items[0].text).toBe("will keep");
    });

    it("supports search filter", async () => {
      await store.findOrCreate(PID, "Azure deployment");
      await store.findOrCreate(PID, "React frontend");
      const { items, total } = await store.getAll({ search: "azure" });
      expect(total).toBe(1);
      expect(items[0].text).toBe("Azure deployment");
    });

    it("defaults to all prompt types (including agents.md and legacy untyped docs)", async () => {
      await store.findOrCreate(PID, "a task prompt");
      await store.findOrCreate(PID, "an agents file", "agents.md");
      const { items, total } = await store.getAll();
      expect(total).toBe(2);
      expect(items.map((i) => i.text).sort()).toEqual(["a task prompt", "an agents file"]);
    });

    it("filters by agents.md type", async () => {
      await store.findOrCreate(PID, "a task prompt");
      await store.findOrCreate(PID, "an agents file", "agents.md");
      const { items, total } = await store.getAll({ type: "agents.md" });
      expect(total).toBe(1);
      expect(items[0].text).toBe("an agents file");
    });
  });

  // -- attachFeatures -------------------------------------------------------

  describe("attachFeatures", () => {
    it("attaches features to a task prompt", async () => {
      const doc = await store.findOrCreate(PID, "feature target");
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
      const doc = await store.findOrCreate(PID, "overwrite target");
      const v1: PromptFeatureResult[] = [{ featureId: "a", detected: true, evaluated: true }];
      const v2: PromptFeatureResult[] = [{ featureId: "b", detected: false, evaluated: true }];

      await store.attachFeatures(doc._id, v1);
      const updated = await store.attachFeatures(doc._id, v2);
      expect(updated.features).toEqual(v2);
    });
  });
});
