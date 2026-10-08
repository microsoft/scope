// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration test for the queue-processor redelivery handler (situation A1).
 *
 * Runs against REAL infrastructure (Azurite queue + Redis), not mocks. The
 * containers are provisioned automatically via testcontainers in beforeAll —
 * no `pnpm docker:up:infra` required, only a reachable Docker daemon:
 *   pnpm test:integration:queue
 *
 * What the 30 unit tests already prove (with a mocked queue): that the
 * fresh-heartbeat branch CALLS safeDeferMessage and NOT safeDeleteMessage.
 *
 * What ONLY this integration test can prove: that a real Azure Storage Queue
 * (Azurite) actually accepts the frozen pop receipt, keeps the message in the
 * queue (does not delete it), and re-surfaces it after the defer window — i.e.
 * the at-least-once recovery token genuinely survives a duplicate dequeue while
 * the original worker is alive. A mock can never prove the queue honored the
 * visibility update; it just returns whatever we told it to.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QueueClient } from "@azure/storage-queue";
import { CodingAgentQueueProcessor } from "./queue-processor.js";
import { RedisHeartbeatStore } from "./heartbeat-store.js";
import { startVisibilityHeartbeat } from "./visibility-heartbeat.js";
import type { QueueProcessorConfig, WorkerProcessor, WorkerResult } from "../types/types.js";
import {
  isDockerAvailable,
  startRedis,
  startAzurite,
  AZURITE_ACCOUNT,
  type StartedRedis,
  type StartedAzurite,
} from "../testing/integration-infra.js";

// ─── Infra is provisioned by testcontainers in beforeAll (dynamic ports) ─────
let redis: StartedRedis;
let azurite: StartedAzurite;

// Skip locally when Docker is absent; FAIL in CI so the suite can never pass
// vacuously by silently skipping — CI must actually exercise the infra.
const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable && process.env.CI) {
  throw new Error(
    "Docker is required for integration tests in CI but no Docker daemon was reachable",
  );
}

const stubProcessor: WorkerProcessor = {
  workerName: "itest-worker",
  getAgentVersion: () => "itest-v1",
  async processMessage(): Promise<WorkerResult> {
    // The duplicate-redelivery path returns BEFORE ever invoking the agent.
    // If this is reached, the fresh-heartbeat branch fell through — a bug.
    throw new Error("processMessage must NOT be called on the duplicate path");
  },
};

function makeConfig(queueName: string): QueueProcessorConfig {
  return {
    mongoUri: "mongodb://127.0.0.1:1",
    mongoDatabase: "unused",
    mongoCollection: "unused",
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("queue-processor redelivery (A1) — fresh heartbeat re-defers, does not delete", () => {
  const queueName = `itest-redefer-${Date.now()}`;
  const runId = `run-${Date.now()}`;
  const requestId = `req-${Date.now()}`;

  let queueClient: QueueClient;
  let heartbeatStore: RedisHeartbeatStore;
  let qp: CodingAgentQueueProcessor;
  const stoppers: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    if (!dockerAvailable) return; // suite is skipped; nothing to provision

    // Start infra failure-safe: record each stopper the moment its container is
    // up, so a later failure still tears down whatever already started.
    azurite = await startAzurite();
    stoppers.push(() => azurite.stop());
    redis = await startRedis();
    stoppers.push(() => redis.stop());

    queueClient = new QueueClient(azurite.connectionString, queueName);
    await queueClient.createIfNotExists();

    heartbeatStore = new RedisHeartbeatStore({
      redisHost: redis.host,
      redisPort: redis.port,
      redisPassword: "",
    });

    qp = new CodingAgentQueueProcessor(makeConfig(queueName), stubProcessor);
    // Inject the real Redis heartbeat store; let the real queueClient (built
    // from the connection string in the base constructor) drive Azurite.
    (qp as any).heartbeatStore = heartbeatStore;
  });

  afterAll(async () => {
    try { await queueClient?.deleteIfExists(); } catch { /* ignore */ }
    try { await heartbeatStore?.delete(runId); } catch { /* ignore */ }
    try { await heartbeatStore?.close(); } catch { /* ignore */ }
    try { await (qp as any)?.mongoClient?.close?.(); } catch { /* ignore */ }
    // Stop containers in reverse start order.
    for (const stop of stoppers.reverse()) {
      try { await stop(); } catch { /* ignore */ }
    }
  });

  it.skipIf(!dockerAvailable)("keeps the message in the queue and re-surfaces it after the defer window", async () => {
    // Configure a short, deterministic defer window (2s) and a long staleness
    // threshold so the heartbeat we write below is unambiguously "fresh".
    const prevDefer = process.env.SCOPE_RUN_REDELIVER_DEFER_MS;
    const prevStale = process.env.SCOPE_RUN_HEARTBEAT_STALE_MS;
    process.env.SCOPE_RUN_REDELIVER_DEFER_MS = "2000";
    process.env.SCOPE_RUN_HEARTBEAT_STALE_MS = "120000";

    try {
      // Original worker is alive: write a FRESH heartbeat for the run.
      await heartbeatStore.set(runId, new Date());

      // Enqueue the run's message, then dequeue it as the "duplicate" worker
      // would (the original worker's lease lapsed). Hide it for 30s so that any
      // later re-appearance can ONLY be the result of our 2s re-defer.
      await queueClient.sendMessage(
        Buffer.from(JSON.stringify({ runId, requestId })).toString("base64"),
      );
      const received = await queueClient.receiveMessages({
        numberOfMessages: 1,
        visibilityTimeout: 30,
      });
      const message = received.receivedMessageItems[0];
      expect(message).toBeDefined();

      // A real per-run visibility heartbeat for THIS duplicate consumer. Use a
      // huge interval so it never ticks during the test; the re-defer path will
      // stop() it to freeze the pop receipt — exactly as in production.
      const heartbeat = startVisibilityHeartbeat(
        queueClient,
        message.messageId,
        message.popReceipt,
        "itest-worker",
        3_600_000, // interval: effectively never auto-ticks
        30, // visibility per tick
        { runId, documentId: requestId },
      );

      const requestDoc = {
        _id: requestId,
        workerType: "itest-worker",
        agentVersion: "itest-v1",
        scenario: { criteria: [], task: "x" },
        run: {
          _id: runId,
          status: "processing",
          attemptNumber: 1,
          startedAt: new Date(),
          worker: { instanceId: "original-worker" },
        },
      } as any;

      const log = async () => {};

      // Drive the REAL redelivery handler against the REAL queue + Redis.
      await (qp as any).handleRequest(requestDoc, message, heartbeat, log, { runId });

      // (1) Immediate proof it was NOT deleted: the queue still reports the
      //     message (invisible, but present). Old code deleted here → count 0.
      const props = await queueClient.getProperties();
      expect(props.approximateMessagesCount).toBeGreaterThanOrEqual(1);

      // (2) Immediate proof it is currently HIDDEN (re-deferred, not visible):
      //     a peek right now returns nothing.
      const peekNow = await queueClient.peekMessages({ numberOfMessages: 1 });
      expect(peekNow.peekedMessageItems.length).toBe(0);

      // (3) End-to-end proof the token survives: after the 2s defer window the
      //     message RE-SURFACES for another liveness re-check. Poll up to ~8s.
      let resurfaced: typeof message | undefined;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await sleep(500);
        const r = await queueClient.receiveMessages({
          numberOfMessages: 1,
          visibilityTimeout: 5,
        });
        if (r.receivedMessageItems.length > 0) {
          resurfaced = r.receivedMessageItems[0];
          break;
        }
      }
      expect(resurfaced).toBeDefined();
      // Same logical message resurfaced (the recovery token), proving re-defer
      // (not delete) and that Azurite honored the visibility update.
      const body = JSON.parse(
        Buffer.from(resurfaced!.messageText, "base64").toString("utf8"),
      );
      expect(body.runId).toBe(runId);
    } finally {
      if (prevDefer === undefined) delete process.env.SCOPE_RUN_REDELIVER_DEFER_MS;
      else process.env.SCOPE_RUN_REDELIVER_DEFER_MS = prevDefer;
      if (prevStale === undefined) delete process.env.SCOPE_RUN_HEARTBEAT_STALE_MS;
      else process.env.SCOPE_RUN_HEARTBEAT_STALE_MS = prevStale;
    }
  }, 30_000);
});
