// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StuckRunReaper } from "./stuck-run-reaper.js";
import { InMemoryHeartbeatStore } from "shared";

const STALE_MS = 120_000;
const OLD = () => new Date(Date.now() - 10 * 60 * 1000); // 10 min ago (> threshold)

function mockCollection(docs: any[]) {
  return {
    find: vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue(docs),
    }),
    findOneAndUpdate: vi.fn().mockResolvedValue({ _id: "claimed" }),
  } as any;
}

function makeReaper(collection: any, store: any) {
  return new StuckRunReaper(collection, store, {
    pollIntervalMs: 999_999,
    staleThresholdMs: STALE_MS,
    maxPerSweep: 30,
    scanLimit: 500,
  });
}

describe("StuckRunReaper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reaps a missing-heartbeat processing run after two consecutive sweeps", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    const store = new InMemoryHeartbeatStore(); // empty → run-1 has no heartbeat
    const delSpy = vi.spyOn(store, "delete");
    const reaper = makeReaper(collection, store);

    // First strike — must NOT reap yet.
    await reaper.sweep();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();

    // Second strike — reap.
    await reaper.sweep();
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = collection.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      _id: "req-1",
      "run._id": "run-1",
      "run.status": "processing",
      "run.worker.instanceId": "w-1",
    });
    expect(update.$set).toMatchObject({
      "run.status": "done",
      "run.outcome": "failed",
    });
    expect(update.$set["run.error"]).toMatch(/Reaped by scheduler/);
    // postProcessorStatus must be left unset for the PostProcessorDispatcher.
    expect(update.$set).not.toHaveProperty("run.postProcessorStatus");
    expect(delSpy).toHaveBeenCalledWith("run-1");
  });

  it("reaps a stale (present-but-old) heartbeat run after two sweeps", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    const store = new InMemoryHeartbeatStore();
    await store.set("run-1", new Date(Date.now() - 5 * 60 * 1000)); // beat 5 min ago → stale
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    await reaper.sweep();
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("aborts the reap when a single-key confirmation read finds a fresh beat (cross-slot mget under-reported)", async () => {
    // Reproduces issue #1064: on a clustered Redis the multi-key mget fails
    // cross-slot and is swallowed into an empty map, so a healthy run looks
    // heartbeat-less across both sweeps — but a single-key get (what the run
    // detail view uses) still returns the fresh beat. The reaper must not fail
    // the run.
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    const store = {
      ping: vi.fn().mockResolvedValue(true),
      mget: vi.fn().mockResolvedValue(new Map()), // cross-slot failure → empty
      get: vi.fn().mockResolvedValue(new Date()), // single-key read works → fresh
      delete: vi.fn(),
    } as any;
    const reaper = makeReaper(collection, store);

    await reaper.sweep(); // strike 1 (looks missing via mget)
    await reaper.sweep(); // strike 2 → reapOne, but confirmation get() aborts
    expect(store.get).toHaveBeenCalledWith("run-1");
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("still reaps when the confirmation read also reports a stale/missing beat", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    const store = {
      ping: vi.fn().mockResolvedValue(true),
      mget: vi.fn().mockResolvedValue(new Map()),
      get: vi.fn().mockResolvedValue(null), // genuinely dead — no beat
      delete: vi.fn(),
    } as any;
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    await reaper.sweep();
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("does NOT reap a run with a fresh heartbeat", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    const store = new InMemoryHeartbeatStore();
    await store.set("run-1", new Date()); // fresh beat
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    await reaper.sweep();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("does NOT reap a recently-started run even with a missing heartbeat", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: new Date(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    const store = new InMemoryHeartbeatStore(); // no heartbeat
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    await reaper.sweep();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("two-strikes absorbs a transient blip (stale once, fresh next)", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    const store = new InMemoryHeartbeatStore(); // sweep 1: missing → stale
    const reaper = makeReaper(collection, store);

    await reaper.sweep(); // first strike
    await store.set("run-1", new Date()); // recovered before sweep 2
    await reaper.sweep(); // not stale now → must not reap
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("skips the sweep entirely when Redis is unreachable (ping false)", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    const store = {
      ping: vi.fn().mockResolvedValue(false),
      mget: vi.fn(),
      delete: vi.fn(),
    } as any;
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    await reaper.sweep();
    expect(collection.find).not.toHaveBeenCalled();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("skips when mget returns no beats and a re-ping fails (read-failure window)", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    // First ping true (enter sweep), mget empty, second ping false (read failed).
    const ping = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const store = {
      ping,
      mget: vi.fn().mockResolvedValue(new Map()),
      delete: vi.fn(),
    } as any;
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    await reaper.sweep(); // would be second strike, but read-failure guard skips
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("circuit-breaker: skips + fails nothing when stale count exceeds maxPerSweep", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
      { _id: "req-2", run: { _id: "run-2", startedAt: OLD(), worker: { instanceId: "w-2" } } },
      { _id: "req-3", run: { _id: "run-3", startedAt: OLD(), worker: { instanceId: "w-3" } } },
    ];
    const collection = mockCollection(docs);
    const store = new InMemoryHeartbeatStore(); // all missing → all stale
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reaper = new StuckRunReaper(collection, store, {
      staleThresholdMs: STALE_MS,
      maxPerSweep: 2, // 3 stale > 2 → trip
    });

    await reaper.sweep(); // first strike (all three)
    await reaper.sweep(); // toReap=3 > 2 → skip
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it("uses {run.worker.instanceId:{$exists:false}} filter when worker identity is absent", async () => {
    const docs = [{ _id: "req-1", run: { _id: "run-1", startedAt: OLD() } }];
    const collection = mockCollection(docs);
    const store = new InMemoryHeartbeatStore();
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    await reaper.sweep();
    const [filter] = collection.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ "run.worker.instanceId": { $exists: false } });
    expect(filter).not.toHaveProperty("run.worker");
  });

  it("treats a legacy version-only worker sub-document as having no owner (#855)", async () => {
    // Migration 031 moves a pre-#846 run's version into run.worker.version
    // without an instanceId — the claim must still match that document.
    const docs = [{ _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { version: "v-legacy" } } }];
    const collection = mockCollection(docs);
    const store = new InMemoryHeartbeatStore();
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    await reaper.sweep();
    const [filter, update] = collection.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ "run.worker.instanceId": { $exists: false } });
    expect(update.$set["run.error"]).toMatch(/instance=unknown/);
  });

  it("does not delete the heartbeat when the claim no-ops (ownership changed)", async () => {
    const docs = [
      { _id: "req-1", run: { _id: "run-1", startedAt: OLD(), worker: { instanceId: "w-1" } } },
    ];
    const collection = mockCollection(docs);
    collection.findOneAndUpdate.mockResolvedValue(null); // claim lost
    const store = new InMemoryHeartbeatStore();
    const delSpy = vi.spyOn(store, "delete");
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    await reaper.sweep();
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(delSpy).not.toHaveBeenCalled();
  });

  it("queries only the indexed run.status (no run.startedAt range filter) — CosmosDB-safe", async () => {
    const collection = mockCollection([]);
    const store = new InMemoryHeartbeatStore();
    const reaper = makeReaper(collection, store);

    await reaper.sweep();
    const [filter] = collection.find.mock.calls[0];
    expect(filter).toMatchObject({ "run.status": "processing" });
    expect(filter).not.toHaveProperty("run.startedAt");
  });
});
