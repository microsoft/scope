// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration tests for the StuckRunReaper (situations A2, B3, B4).
 *
 * Runs against REAL infrastructure (MongoDB + Redis + Azurite), not mocks. The
 * containers are provisioned automatically via testcontainers in beforeAll —
 * no `pnpm docker:up:infra` required, only a reachable Docker daemon:
 *   pnpm test:integration:queue
 *
 * What the 11 unit tests already prove (with a mocked collection): the branch
 * logic — two-strikes, ping skip, circuit-breaker, claim filter shape.
 *
 * What ONLY this integration test can prove:
 *   A2  — the reaper's REAL Mongo query (`run.status:"processing"` + in-memory
 *         startedAt cutoff) actually finds a stuck run that has no queue message
 *         in existence, and the atomic findOneAndUpdate claims it on a real
 *         Mongo-compatible engine (no range index needed — CosmosDB-safe).
 *   B3  — the false-positive safety guarantee is enforced by REAL worker code:
 *         once the reaper sets `done`, a worker that later dequeues the run's
 *         still-queued message runs the real CodingAgentQueueProcessor
 *         handleRequest terminal-status guard, which discards the message
 *         (deletes it from Azurite) without re-running the agent or reviving
 *         the run. (The deeper DB-level status-gated *write* — the worker error
 *         path's updateOne gated on `run.status:"processing"` — is covered by
 *         the worker unit test and, on real Mongo, by A2's atomic claim; it is
 *         unreachable here because the terminal guard short-circuits first.)
 *   B4  — a run the worker completes between reaper strikes is never reaped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoClient, Collection } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import { CodingAgentQueueProcessor, RedisHeartbeatStore, startVisibilityHeartbeat } from "shared";
import type { RequestDocument, QueueProcessorConfig, WorkerProcessor, WorkerResult } from "shared";
import { StuckRunReaper } from "./stuck-run-reaper.js";
import {
  isDockerAvailable,
  startMongo,
  startRedis,
  startAzurite,
  AZURITE_ACCOUNT,
  type StartedMongo,
  type StartedRedis,
  type StartedAzurite,
} from "./testing/integration-infra.js";

// ─── Infra is provisioned by testcontainers in beforeAll (dynamic ports) ─────
const DB_NAME = `reaper-itest-${Date.now()}`;

const STALE_MS = 1000; // tiny threshold so the test isn't slow
const TEN_MIN_AGO = () => new Date(Date.now() - 10 * 60 * 1000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Skip locally when Docker is absent; FAIL in CI so the suite can never pass
// vacuously by silently skipping — CI must actually exercise the infra.
const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable && process.env.CI) {
  throw new Error(
    "Docker is required for integration tests in CI but no Docker daemon was reachable",
  );
}

// A real worker whose AGENT step must never run for an already-reaped run. If
// the terminal-status guard regressed, handleRequest would fall through to
// processMultiTurn → this throws → the test fails (keeps the test honest).
function makeStubAgent(): { processor: WorkerProcessor; called: () => boolean } {
  let invoked = false;
  return {
    processor: {
      workerName: "itest-worker",
      getAgentVersion: () => "itest-v1",
      async processMessage(): Promise<WorkerResult> {
        invoked = true;
        throw new Error("agent must NOT run for a reaped run");
      },
    },
    called: () => invoked,
  };
}

function makeQueueConfig(queueName: string): QueueProcessorConfig {
  return {
    mongoUri: mongoInfra.uri,
    mongoDatabase: DB_NAME,
    mongoCollection: "requests",
    storageAccountName: AZURITE_ACCOUNT,
    storageConnectionString: azurite.connectionString,
    queueName,
    batchSize: 1,
    pollIntervalMs: 1000,
    redisHost: redis.host,
    redisPort: redis.port,
    redisPassword: "",
  };
}

let mongo: MongoClient;
let collection: Collection<RequestDocument>;
let heartbeatStore: RedisHeartbeatStore;
let mongoInfra: StartedMongo;
let redis: StartedRedis;
let azurite: StartedAzurite;
const stoppers: Array<() => Promise<void>> = [];

function makeReaper(): StuckRunReaper {
  return new StuckRunReaper(collection, heartbeatStore, {
    staleThresholdMs: STALE_MS,
    maxPerSweep: 30,
    pollIntervalMs: 3_600_000, // never auto-fires; tests call sweep() directly
  });
}

async function insertRun(
  id: string,
  runId: string,
  overrides: Partial<RequestDocument["run"]> = {},
): Promise<void> {
  await collection.insertOne({
    _id: id,
    workerType: "itest-worker",
    agentVersion: "itest-v1",
    scenario: { criteria: [], task: "x" },
    run: {
      _id: runId,
      status: "processing",
      attemptNumber: 1,
      startedAt: TEN_MIN_AGO(),
      worker: { instanceId: "worker-A" },
      ...overrides,
    },
  } as any);
}

const getRun = (id: string) =>
  collection.findOne({ _id: id } as any).then((d) => (d as any)?.run);

describe("StuckRunReaper integration (A2 / B3 / B4)", () => {
  beforeAll(async () => {
    if (!dockerAvailable) return; // suite is skipped; nothing to provision

    // Start infra failure-safe: record each stopper the moment its container is
    // up, so a later failure still tears down whatever already started.
    mongoInfra = await startMongo();
    stoppers.push(() => mongoInfra.stop());
    redis = await startRedis();
    stoppers.push(() => redis.stop());
    azurite = await startAzurite();
    stoppers.push(() => azurite.stop());

    mongo = new MongoClient(mongoInfra.uri);
    await mongo.connect();
    collection = mongo.db(DB_NAME).collection<RequestDocument>("requests");
    heartbeatStore = new RedisHeartbeatStore({
      redisHost: redis.host,
      redisPort: redis.port,
      redisPassword: "",
    });
  });

  afterAll(async () => {
    try { await mongo?.db(DB_NAME).dropDatabase(); } catch { /* ignore */ }
    try { await mongo?.close(); } catch { /* ignore */ }
    try { await heartbeatStore?.close(); } catch { /* ignore */ }
    // Stop containers in reverse start order.
    for (const stop of stoppers.reverse()) {
      try { await stop(); } catch { /* ignore */ }
    }
  });

  beforeEach(async () => {
    if (!dockerAvailable) return;
    await collection.deleteMany({} as any);
  });

  it.skipIf(!dockerAvailable)("A2: reaps a stuck processing run with no heartbeat (after two strikes), sparing fresh-beat runs", async () => {
    // Stuck: old + no heartbeat → dead worker, no queue message will save it.
    await insertRun("req-stuck", "run-stuck", { worker: { instanceId: "worker-A" } });
    // Old enough to be a candidate, but its worker is ALIVE (fresh beat) →
    // proves the reaper checks the heartbeat, not just age.
    await insertRun("req-alive", "run-alive", { worker: { instanceId: "worker-B" } });
    await heartbeatStore.set("run-alive", new Date());
    // Ensure the stuck run truly has no beat.
    await heartbeatStore.delete("run-stuck");

    const reaper = makeReaper();

    // Strike 1: two-strikes means nothing is reaped on first observation.
    await reaper.sweep();
    expect((await getRun("req-stuck")).status).toBe("processing");
    expect((await getRun("req-alive")).status).toBe("processing");

    // Strike 2: the persistently-stale run is now reaped; the alive run is not.
    await reaper.sweep();
    const stuck = await getRun("req-stuck");
    expect(stuck.status).toBe("done");
    expect(stuck.outcome).toBe("failed");
    expect(stuck.error).toMatch(/Reaped by scheduler/);
    expect(stuck.finishedAt).toBeTruthy();

    const alive = await getRun("req-alive");
    expect(alive.status).toBe("processing");
    expect(alive.outcome).toBeUndefined();

    // Heartbeat key for the reaped run is cleaned up.
    expect(await heartbeatStore.get("run-stuck")).toBeNull();
  }, 30_000);

  it.skipIf(!dockerAvailable)("B3: a worker that dequeues an already-reaped run's message discards it via the REAL terminal-status guard (no revival, no agent run)", async () => {
    await insertRun("req-fp", "run-fp", { worker: { instanceId: "worker-A" } });
    await heartbeatStore.delete("run-fp");

    // The reaper genuinely fails the run (two strikes).
    const reaper = makeReaper();
    await reaper.sweep(); // strike 1
    await reaper.sweep(); // strike 2 → reaped
    expect((await getRun("req-fp")).status).toBe("done");
    expect((await getRun("req-fp")).outcome).toBe("failed");

    // A real worker now dequeues the run's still-queued message and runs the
    // REAL handleRequest. Because run.status is already "done", the production
    // terminal-status guard must delete the message and return — never running
    // the agent, never writing to Mongo, never reviving the run.
    const queueName = `itest-reaped-${Date.now()}`;
    const queueClient = new QueueClient(azurite.connectionString, queueName);
    await queueClient.createIfNotExists();
    const agent = makeStubAgent();
    const qp = new CodingAgentQueueProcessor(makeQueueConfig(queueName), agent.processor);
    // Inject the real Redis heartbeat store; the real Azurite queueClient is
    // built by the base constructor from the connection string.
    (qp as any).heartbeatStore = heartbeatStore;

    try {
      await queueClient.sendMessage(
        Buffer.from(JSON.stringify({ runId: "run-fp", requestId: "req-fp" })).toString("base64"),
      );
      // Short visibility window so that "no redelivery after it expires" is a
      // SOUND proof of DELETION, not merely of the message still being hidden.
      const received = await queueClient.receiveMessages({
        numberOfMessages: 1,
        visibilityTimeout: 3,
      });
      const message = received.receivedMessageItems[0];
      expect(message).toBeDefined();

      // Real per-run visibility heartbeat; huge interval so it never auto-ticks.
      // The terminal-guard path does not stop it (production's processMessage
      // stops it in a finally), so we stop it ourselves to avoid a leaked timer.
      const heartbeat = startVisibilityHeartbeat(
        queueClient,
        message.messageId,
        message.popReceipt,
        "itest-worker",
        3_600_000,
        30,
        { runId: "run-fp", documentId: "req-fp" },
      );

      const reapedDoc = await collection.findOne({ _id: "req-fp" } as any);
      const log = async () => {};

      try {
        // Drive the REAL worker decision path against the reaped doc.
        await (qp as any).handleRequest(reapedDoc, message, heartbeat, log, {
          runId: "run-fp",
          requestId: "req-fp",
        });
      } finally {
        heartbeat.stop();
      }

      // (1) The agent never ran — the terminal guard short-circuited.
      expect(agent.called()).toBe(false);

      // (2) The message was DELETED by the guard: after the 3s visibility window
      //     expires it does NOT re-surface. (A re-defer or a no-op would.)
      await sleep(3500);
      const after = await queueClient.receiveMessages({
        numberOfMessages: 1,
        visibilityTimeout: 5,
      });
      expect(after.receivedMessageItems.length).toBe(0);

      // (3) The reaped run was NOT revived — handleRequest never wrote to Mongo
      //     on the terminal-discard path.
      const run = await getRun("req-fp");
      expect(run.status).toBe("done");
      expect(run.outcome).toBe("failed");
      expect(run.error).toMatch(/Reaped by scheduler/);
    } finally {
      try { await queueClient.deleteIfExists(); } catch { /* ignore */ }
      try { await (qp as any).mongoClient?.close?.(); } catch { /* ignore */ }
    }
  }, 30_000);

  it.skipIf(!dockerAvailable)("B4: a run the worker completes between strikes is never reaped", async () => {
    await insertRun("req-race", "run-race", { worker: { instanceId: "worker-A" } });
    await heartbeatStore.delete("run-race");

    const reaper = makeReaper();
    await reaper.sweep(); // strike 1 — observed stale, not yet reaped

    // The worker finishes successfully before the second strike.
    const res = await collection.updateOne(
      { _id: "req-race", "run._id": "run-race", "run.status": "processing" } as any,
      { $set: { "run.status": "done", "run.outcome": "passed", "run.finishedAt": new Date() } } as any,
    );
    expect(res.matchedCount).toBe(1);

    await reaper.sweep(); // strike 2 — run is no longer a candidate

    const run = await getRun("req-race");
    expect(run.status).toBe("done");
    expect(run.outcome).toBe("passed"); // reaper never touched it
    expect(run.error).toBeUndefined();
  }, 30_000);
});
