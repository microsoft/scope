// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { CriteriaStore } from "./criteria-store.js";
import {
  CriteriaDuplicateError,
  CriteriaHasDependentsError,
  CriteriaNotFoundError,
  CriteriaValidationError,
} from "./criteria-errors.js";
import type { CriteriaDocument, GateId } from "../types/types.js";

/**
 * Minimal in-memory fake of the subset of the MongoDB Collection API that
 * CriteriaStore exercises: findOne, insertOne, updateOne and find().sort().toArray().
 */
function fakeCollection(seed: CriteriaDocument[] = []) {
  let docs: CriteriaDocument[] = seed.map((d) => ({ ...d }));

  const matches = (doc: any, filter: any): boolean => {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === "deletedAt") {
        const hasDeleted = doc.deletedAt !== undefined;
        if ((cond as any)?.$exists === false && hasDeleted) return false;
        if ((cond as any)?.$exists === true && !hasDeleted) return false;
        continue;
      }
      if (key === "dependsOn") {
        if (!Array.isArray(doc.dependsOn) || !doc.dependsOn.includes(cond)) return false;
        continue;
      }
      if (doc[key] !== cond) return false;
    }
    return true;
  };

  return {
    _docs: () => docs,
    async findOne(filter: any) {
      return docs.find((d) => matches(d, filter)) ?? null;
    },
    async insertOne(doc: any) {
      // Faithfully model the unique index on `{ projectId, id }` (migration 026,
      // which replaced migration 002's global `{ id }`): it does NOT exclude
      // soft-deleted docs, so inserting over a tombstone in the SAME project
      // collides, while the same id in a DIFFERENT project is allowed.
      if (docs.some((d) => d.projectId === doc.projectId && d.id === doc.id)) {
        throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
      }
      docs.push({ ...doc });
      return { insertedId: doc.id };
    },
    async updateOne(filter: any, update: any) {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) {
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$unset) {
          for (const key of Object.keys(update.$unset)) delete (doc as any)[key];
        }
      }
      return { matchedCount: doc ? 1 : 0 };
    },
    find(filter: any) {
      let result = docs.filter((d) => matches(d, filter));
      return {
        sort() {
          return this;
        },
        async toArray() {
          return result;
        },
      };
    },
  } as any;
}

describe("CriteriaStore gate-compatibility invariant", () => {
  it("allows a child whose gates are a subset of its parent's gates", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select", "build"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], gates: ["build"] }),
    ).resolves.toMatchObject({ id: "child", gates: ["build"] });
  });

  it("rejects a child compatible with a gate its parent is not", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], gates: ["select", "build"] }),
    ).rejects.toThrow(/not/i);
  });

  it("rejects an unrestricted child of a restricted parent", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    // No gates on child => universal (all gates) => must fail against select-only parent.
    await expect(
      store.create({ projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"] }),
    ).rejects.toThrow();
  });

  it("allows an unrestricted child of an unrestricted parent", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"] }),
    ).resolves.toMatchObject({ id: "child" });
  });

  it("enforces the invariant on update too", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select"], createdAt: new Date() },
      { projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], gates: ["select"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.update("child", { gates: ["select", "build"] as GateId[] }),
    ).rejects.toThrow();
  });

  it("rejects narrowing a parent below an existing dependent's gates (parent side)", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select", "build"], createdAt: new Date() },
      { projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], gates: ["select", "build"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    // Narrowing parent to just [select] would leave child (compatible with build)
    // depending on a parent that is not — the parent-side invariant must reject.
    await expect(
      store.update("parent", { gates: ["select"] as GateId[] }),
    ).rejects.toThrow(CriteriaValidationError);
  });
});

describe("CriteriaStore cycle detection", () => {
  it("rejects a direct cycle on create", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "a", prompt: "a", dependsOn: ["b"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ projectId: "proj-test", id: "b", prompt: "b", dependsOn: ["a"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });

  it("rejects a transitive cycle on update", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "a", prompt: "a", dependsOn: [], createdAt: new Date() },
      { projectId: "proj-test", id: "b", prompt: "b", dependsOn: ["a"], createdAt: new Date() },
      { projectId: "proj-test", id: "c", prompt: "c", dependsOn: ["b"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    // a -> b -> c already; making a depend on c closes the loop a->c->b->a.
    await expect(
      store.update("a", { dependsOn: ["c"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });

  it("rejects a self-reference", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "a", prompt: "a", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.update("a", { dependsOn: ["a"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });
});

describe("CriteriaStore typed errors", () => {
  it("throws CriteriaValidationError for an invalid id format", async () => {
    const store = new CriteriaStore(fakeCollection());
    await expect(store.create({ projectId: "proj-test", id: "Bad-Id", prompt: "p" })).rejects.toThrow(
      CriteriaValidationError,
    );
  });

  it("throws CriteriaDuplicateError when the id already exists", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "dup", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);
    await expect(store.create({ projectId: "proj-test", id: "dup", prompt: "p" })).rejects.toThrow(
      CriteriaDuplicateError,
    );
  });

  it("throws CriteriaValidationError when a dependency does not exist", async () => {
    const store = new CriteriaStore(fakeCollection());
    await expect(
      store.create({ projectId: "proj-test", id: "a", prompt: "p", dependsOn: ["missing"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });

  it("throws CriteriaNotFoundError on update of a missing criterion", async () => {
    const store = new CriteriaStore(fakeCollection());
    await expect(store.update("ghost", { prompt: "x" })).rejects.toThrow(
      CriteriaNotFoundError,
    );
  });

  it("throws CriteriaNotFoundError on delete of a missing criterion", async () => {
    const store = new CriteriaStore(fakeCollection());
    await expect(store.delete("ghost")).rejects.toThrow(CriteriaNotFoundError);
  });

  it("throws CriteriaHasDependentsError carrying dependent ids on delete", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], createdAt: new Date() },
      { projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(store.delete("parent")).rejects.toMatchObject({
      dependents: ["child"],
    });
    await expect(store.delete("parent")).rejects.toBeInstanceOf(
      CriteriaHasDependentsError,
    );
  });

  it("deletes a criterion that has no dependents", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "lonely", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);
    await store.delete("lonely");
    expect(await store.get("lonely")).toBeNull();
  });
});

describe("CriteriaStore revives soft-deleted ids on re-create", () => {
  it("re-creating a soft-deleted id succeeds and returns a fresh active criterion", async () => {
    const col = fakeCollection([
      {
        id: "revive_me",
        projectId: "proj-test",
        prompt: "old",
        dependsOn: [],
        createdAt: new Date("2020-01-01"),
        updatedAt: new Date("2020-02-01"),
        deletedAt: new Date("2020-03-01"),
      },
    ]);
    const store = new CriteriaStore(col);

    const created = await store.create({ projectId: "proj-test", id: "revive_me", prompt: "new" });

    expect(created.prompt).toBe("new");
    expect((created as any).deletedAt).toBeUndefined();

    // It is now visible as an active criterion with the tombstone cleared.
    const fetched = await store.get("revive_me");
    expect(fetched).not.toBeNull();
    expect(fetched!.prompt).toBe("new");
    expect((fetched as any).deletedAt).toBeUndefined();
    expect((fetched as any).updatedAt).toBeUndefined();

    // No duplicate row was created — the tombstone was overwritten in place.
    expect(col._docs().filter((d: CriteriaDocument) => d.id === "revive_me")).toHaveLength(1);
  });

  it("still enforces validation when reviving (cycle rejected, tombstone untouched)", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "a", prompt: "a", dependsOn: ["b"], createdAt: new Date() },
      {
        id: "b",
        projectId: "proj-test",
        prompt: "old",
        dependsOn: [],
        createdAt: new Date("2020-01-01"),
        deletedAt: new Date("2020-03-01"),
      },
    ]);
    const store = new CriteriaStore(col);

    // Reviving "b" with a dependency on "a" would form a cycle a->b->a.
    await expect(
      store.create({ projectId: "proj-test", id: "b", prompt: "new", dependsOn: ["a"] }),
    ).rejects.toThrow(CriteriaValidationError);

    // The tombstone must remain soft-deleted and unchanged.
    const b = col._docs().find((d: CriteriaDocument) => d.id === "b")!;
    expect(b.deletedAt).toBeDefined();
    expect(b.prompt).toBe("old");
  });

  it("an active duplicate still throws CriteriaDuplicateError (not revived)", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "active", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);
    await expect(store.create({ projectId: "proj-test", id: "active", prompt: "q" })).rejects.toThrow(
      CriteriaDuplicateError,
    );
  });
});

describe("CriteriaStore per-project isolation (migration 026)", () => {
  it("allows the same criterion id to exist independently in two projects", async () => {
    // One shared underlying collection, two project-scoped stores.
    const col = fakeCollection();
    const storeA = new CriteriaStore(col, "proj-a");
    const storeB = new CriteriaStore(col, "proj-b");

    const a = await storeA.create({ projectId: "proj-a", id: "shared_id", prompt: "from A" });
    const b = await storeB.create({ projectId: "proj-b", id: "shared_id", prompt: "from B" });

    // No cross-project 409: both creates succeed and land as two distinct rows.
    expect(a.id).toBe("shared_id");
    expect(b.id).toBe("shared_id");
    const rows = col._docs().filter((d: CriteriaDocument) => d.id === "shared_id");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((d: CriteriaDocument) => d.projectId))).toEqual(
      new Set(["proj-a", "proj-b"]),
    );
  });

  describe("CriteriaStore kind + taxonomy (issue #1156)", () => {
    it("defaults kind to gate and subject to iteration", async () => {
      const store = new CriteriaStore(fakeCollection());
      const created = await store.create({ projectId: "proj-test", id: "g1", prompt: "p" });
      expect(created.kind).toBe("gate");
      expect(created.subject).toBe("iteration");
      expect(created.taxonomyElementId).toBeUndefined();
    });

    it("persists observation taxonomy and defaults subject to run", async () => {
      const store = new CriteriaStore(fakeCollection());
      const created = await store.create({
        projectId: "proj-test",
        id: "obs1",
        prompt: "p",
        kind: "observation",
        taxonomyElementId: "dimension:idiomatic-use",
      });
      expect(created.kind).toBe("observation");
      expect(created.taxonomyElementId).toBe("dimension:idiomatic-use");
      expect(created.subject).toBe("run");
    });

    it("rejects taxonomy and run subject on gate criteria", async () => {
      const store = new CriteriaStore(fakeCollection());
      await expect(
        store.create({
          projectId: "proj-test",
          id: "g2",
          prompt: "p",
          kind: "gate",
          taxonomyElementId: "dimension:idiomatic-use",
        }),
      ).rejects.toThrow(CriteriaValidationError);
      await expect(
        store.create({
          projectId: "proj-test",
          id: "g3",
          prompt: "p",
          kind: "gate",
          subject: "run",
        }),
      ).rejects.toThrow(CriteriaValidationError);
    });

    it("enforces same-kind dependencies and resolves observations", async () => {
      const col = fakeCollection([
        { projectId: "proj-test", id: "obs", prompt: "o", dependsOn: [], kind: "observation", createdAt: new Date() },
        { projectId: "proj-test", id: "gate", prompt: "g", dependsOn: [], kind: "gate", createdAt: new Date() },
      ]);
      const store = new CriteriaStore(col, "proj-test");
      await expect(
        store.create({
          projectId: "proj-test",
          id: "gate_child",
          prompt: "p",
          kind: "gate",
          dependsOn: ["obs"],
        }),
      ).rejects.toThrow(CriteriaValidationError);
      await expect(store.resolveObservations(["obs"])).resolves.toHaveLength(1);
      await expect(store.resolveObservations(["gate"])).rejects.toThrow(CriteriaValidationError);
    });

    it("supports an explicit per-iteration observation and rejects an invalid kind flip", async () => {
      const col = fakeCollection();
      const store = new CriteriaStore(col, "proj-test");
      const created = await store.create({
        projectId: "proj-test",
        id: "obs_iter",
        prompt: "p",
        kind: "observation",
        subject: "iteration",
      });
      expect(created.subject).toBe("iteration");

      const runObservation = await store.create({
        projectId: "proj-test",
        id: "obs_run",
        prompt: "p",
        kind: "observation",
      });
      expect(runObservation.subject).toBe("run");
      await expect(store.update("obs_run", { kind: "gate" })).rejects.toThrow(
        CriteriaValidationError,
      );
    });
  });

  it("still rejects a same-id duplicate WITHIN a project", async () => {
    const col = fakeCollection();
    const storeA = new CriteriaStore(col, "proj-a");
    const storeB = new CriteriaStore(col, "proj-b");

    await storeA.create({ projectId: "proj-a", id: "dup", prompt: "x" });
    await storeB.create({ projectId: "proj-b", id: "dup", prompt: "y" });

    // The second create in proj-a is a real in-project collision.
    await expect(storeA.create({ projectId: "proj-a", id: "dup", prompt: "z" })).rejects.toThrow(
      CriteriaDuplicateError,
    );
  });

  it("scopes reads to the store's project (get returns that project's copy only)", async () => {
    const col = fakeCollection();
    const storeA = new CriteriaStore(col, "proj-a");
    const storeB = new CriteriaStore(col, "proj-b");
    await storeA.create({ projectId: "proj-a", id: "shared_id", prompt: "from A" });
    await storeB.create({ projectId: "proj-b", id: "shared_id", prompt: "from B" });

    expect((await storeA.get("shared_id"))!.prompt).toBe("from A");
    expect((await storeB.get("shared_id"))!.prompt).toBe("from B");
  });

  it("confines DAG dependency resolution to the store's project", async () => {
    // A "parent" exists only in proj-a. A create in proj-b that dependsOn "parent"
    // must fail because the dependency is not visible in proj-b.
    const col = fakeCollection();
    const storeA = new CriteriaStore(col, "proj-a");
    const storeB = new CriteriaStore(col, "proj-b");
    await storeA.create({ projectId: "proj-a", id: "parent", prompt: "p" });

    await expect(
      storeB.create({ projectId: "proj-b", id: "child", prompt: "c", dependsOn: ["parent"] }),
    ).rejects.toThrow(CriteriaValidationError);

    // Within proj-a the same dependency resolves fine.
    await expect(
      storeA.create({ projectId: "proj-a", id: "child", prompt: "c", dependsOn: ["parent"] }),
    ).resolves.toBeTruthy();
  });

  it("rejects create() when input.projectId disagrees with the store's scope", async () => {
    // The dedup/uniqueness checks run through `scoped()` (this.projectId) while the
    // row is written with the resolved project id. If they disagreed, the check
    // would run in one project and the insert land in another — a silent
    // cross-project write. A scoped store must refuse a mismatched input.
    const col = fakeCollection();
    const storeA = new CriteriaStore(col, "proj-a");

    await expect(
      storeA.create({ projectId: "proj-b", id: "x", prompt: "p" }),
    ).rejects.toThrow(CriteriaValidationError);

    // Nothing was written.
    expect(col._docs()).toHaveLength(0);
  });

  it("writes under the store's scope even if input omits projectId", async () => {
    // A scoped store is the source of truth for the project id; the check and the
    // insert must both use it.
    const col = fakeCollection();
    const storeA = new CriteriaStore(col, "proj-a");

    await storeA.create({ projectId: undefined as unknown as string, id: "y", prompt: "p" });

    expect(col._docs()).toEqual([expect.objectContaining({ id: "y", projectId: "proj-a" })]);
  });
});
