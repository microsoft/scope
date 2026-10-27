// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";
import {
  MoveWorkerVersion,
  buildWorkerVersionMoveUpdate,
  buildWorkerVersionRevertUpdate,
} from "./migrations/031-move-worker-version.js";

vi.mock("./batch-update.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./batch-update.js")>(),
  sleep: vi.fn(async () => {}),
}));

describe("buildWorkerVersionMoveUpdate", () => {
  it("moves the version into worker.version and unsets the legacy field", () => {
    expect(buildWorkerVersionMoveUpdate({ workerVersion: "v1", worker: { instanceId: "i-1" } }, "run.")).toEqual({
      $set: { "run.worker.version": "v1" },
      $unset: { "run.workerVersion": "" },
    });
  });

  it("creates a version-only worker for runs that predate worker identity", () => {
    expect(buildWorkerVersionMoveUpdate({ workerVersion: "v1" }, "")).toEqual({
      $set: { "worker.version": "v1" },
      $unset: { workerVersion: "" },
    });
  });

  it("never overwrites an existing worker.version, but still unsets the legacy field", () => {
    expect(buildWorkerVersionMoveUpdate({ workerVersion: "old", worker: { version: "new" } }, "run.")).toEqual({
      $set: {},
      $unset: { "run.workerVersion": "" },
    });
  });

  it("returns null when there is nothing to move", () => {
    expect(buildWorkerVersionMoveUpdate({ worker: { instanceId: "i-1" } }, "run.")).toBeNull();
    expect(buildWorkerVersionMoveUpdate(undefined, "run.")).toBeNull();
  });
});

describe("buildWorkerVersionRevertUpdate", () => {
  it("moves worker.version back and keeps the rest of worker", () => {
    expect(buildWorkerVersionRevertUpdate({ worker: { instanceId: "i-1", version: "v1" } }, "run.")).toEqual({
      $set: { "run.workerVersion": "v1" },
      $unset: { "run.worker.version": "" },
    });
  });

  it("drops a version-only worker sub-document entirely", () => {
    expect(buildWorkerVersionRevertUpdate({ worker: { version: "v1" } }, "")).toEqual({
      $set: { workerVersion: "v1" },
      $unset: { worker: "" },
    });
  });

  it("returns null without a worker.version", () => {
    expect(buildWorkerVersionRevertUpdate({ worker: { instanceId: "i-1" } }, "run.")).toBeNull();
  });
});

/** In-memory fake of the two collections the migration touches. */
function makeDb(collections: Record<string, Array<Record<string, any>>>) {
  const updates: Record<string, Array<{ filter: any; update: any }>> = {};
  const db = {
    collection: (name: string) => {
      updates[name] ??= [];
      return {
        find: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield* collections[name] ?? [];
          },
        })),
        updateOne: vi.fn(async (filter: any, update: any) => {
          updates[name].push({ filter, update });
          return { modifiedCount: 1 };
        }),
      };
    },
  } as unknown as Db;
  return { db, updates };
}

describe("MoveWorkerVersion.up", () => {
  it("rewrites requests and run-history documents", async () => {
    const { db, updates } = makeDb({
      requests: [
        { _id: "req-1", run: { workerVersion: "v1", worker: { instanceId: "i-1" } } },
        { _id: "req-2", run: { workerVersion: "v2" } },
      ],
      runs: [{ _id: "run-1", workerVersion: "v0", worker: { instanceId: "i-0", podName: "p" } }],
    });

    await new MoveWorkerVersion().up(db);

    expect(updates.requests).toEqual([
      { filter: { _id: "req-1" }, update: { $set: { "run.worker.version": "v1" }, $unset: { "run.workerVersion": "" } } },
      { filter: { _id: "req-2" }, update: { $set: { "run.worker.version": "v2" }, $unset: { "run.workerVersion": "" } } },
    ]);
    expect(updates.runs).toEqual([
      { filter: { _id: "run-1" }, update: { $set: { "worker.version": "v0" }, $unset: { workerVersion: "" } } },
    ]);
  });

  it("omits an empty $set when worker.version already exists", async () => {
    const { db, updates } = makeDb({
      requests: [{ _id: "req-1", run: { workerVersion: "old", worker: { instanceId: "i-1", version: "new" } } }],
      runs: [],
    });

    await new MoveWorkerVersion().up(db);

    expect(updates.requests).toEqual([
      { filter: { _id: "req-1" }, update: { $unset: { "run.workerVersion": "" } } },
    ]);
  });

  it("retries a write on CosmosDB 429", async () => {
    const { db } = makeDb({ requests: [{ _id: "req-1", run: { workerVersion: "v1" } }], runs: [] });
    const requests = db.collection("requests") as any;
    requests.updateOne
      .mockRejectedValueOnce(Object.assign(new Error("RetryAfterMs=1"), { code: 16500 }))
      .mockResolvedValueOnce({ modifiedCount: 1 });
    const patched = { collection: (name: string) => (name === "requests" ? requests : db.collection(name)) } as unknown as Db;

    await new MoveWorkerVersion().up(patched);

    expect(requests.updateOne).toHaveBeenCalledTimes(2);
  });
});

describe("MoveWorkerVersion.down", () => {
  it("restores workerVersion on both collections", async () => {
    const { db, updates } = makeDb({
      requests: [{ _id: "req-1", run: { worker: { instanceId: "i-1", version: "v1" } } }],
      runs: [{ _id: "run-1", worker: { version: "v0" } }],
    });

    await new MoveWorkerVersion().down(db);

    expect(updates.requests).toEqual([
      { filter: { _id: "req-1" }, update: { $set: { "run.workerVersion": "v1" }, $unset: { "run.worker.version": "" } } },
    ]);
    expect(updates.runs).toEqual([
      { filter: { _id: "run-1" }, update: { $set: { workerVersion: "v0" }, $unset: { worker: "" } } },
    ]);
  });
});
