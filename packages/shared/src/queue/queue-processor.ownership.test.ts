// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Run-ownership guards on mid-run writes (issue #803).
 *
 * `runGatedLoop` is mocked so the test drives the processor's real
 * `onTurnComplete` / `onGateComplete` callbacks without an agent or judge.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { QueueProcessorConfig, WorkerProcessor, WorkerResult } from "../types/types.js";
import { InMemoryHeartbeatStore } from "./heartbeat-store.js";

const { runGatedLoop } = vi.hoisted(() => ({ runGatedLoop: vi.fn() }));
vi.mock("../judge/gated-loop.js", () => ({ runGatedLoop }));

const { CodingAgentQueueProcessor } = await import("./queue-processor.js");
const { RunOwnershipLostError, ownedRunFilter } = await import("./run-ownership.js");

const testConfig: QueueProcessorConfig = {
  mongoUri: "mongodb://localhost:27017",
  mongoDatabase: "test-db",
  mongoCollection: "test-collection",
  storageAccountName: "devstoreaccount1",
  storageConnectionString:
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=key;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;",
  queueName: "test-queue",
  batchSize: 1,
  pollIntervalMs: 50,
  redisHost: "localhost",
  redisPort: 6379,
  redisPassword: "",
};

const stubProcessor: WorkerProcessor = {
  workerName: "test-worker",
  async processMessage(): Promise<WorkerResult> {
    return { response: "ok" };
  },
  getAgentVersion() {
    return "test-1.0.0";
  },
};

/** Build a processor wired to a mocked collection and a minimal request doc. */
function makeHarness(updateOne: ReturnType<typeof vi.fn>) {
  const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
  (qp as any).collection = { updateOne };
  (qp as any).heartbeatStore = new InMemoryHeartbeatStore();
  (qp as any).queueClient = { deleteMessage: vi.fn().mockResolvedValue(undefined) };

  const requestDoc = {
    _id: "req-1",
    projectId: "proj-1",
    workerType: "test-worker",
    scenario: { task: "do it", criteria: [] },
    maxIterations: 3,
    run: { _id: "run-1", status: "processing", attemptNumber: 1 },
  } as any;
  const log = vi.fn().mockResolvedValue(undefined);

  const processMultiTurn = () =>
    (qp as any).processMultiTurn(requestDoc, { messageId: "msg-1" }, { stop: () => "receipt-1" }, log, new Date());

  return { qp, processMultiTurn, owned: ownedRunFilter("req-1", "run-1", (qp as any).instanceId) };
}

/** A completed turn as the loop would hand it to `onTurnComplete`. */
function turn(iteration: number) {
  return { iteration, judgeFeedback: "", snapshotUrl: "", passed: false, timestamp: new Date() };
}

describe("CodingAgentQueueProcessor mid-run ownership guards (#803)", () => {
  beforeEach(() => {
    runGatedLoop.mockReset();
  });

  it("filters turn and gate writes on run._id, processing status and worker instance", async () => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const { processMultiTurn, owned } = makeHarness(updateOne);
    runGatedLoop.mockImplementation(async (config: any) => {
      await config.onTurnComplete(turn(1));
      await config.onGateComplete({ gate: "select", status: "passed", iterations: 1 });
      return { turns: [turn(1)], passed: true, hadError: false, finalResult: "ok" };
    });

    await processMultiTurn();

    const [turnFilter, turnUpdate] = updateOne.mock.calls[0];
    expect(turnFilter).toEqual(owned);
    expect(turnUpdate.$push["run.turns"].iteration).toBe(1);

    const [gateFilter, gateUpdate] = updateOne.mock.calls[1];
    expect(gateFilter).toEqual(owned);
    expect(gateUpdate.$push.gateSummaries.gate).toBe("select");

    // The terminal write still runs on the happy path.
    expect(updateOne.mock.calls.some(([, u]) => u.$set?.["run.status"] === "done")).toBe(true);
  });

  it("stops the loop and skips the terminal write once a turn write matches nothing", async () => {
    // First turn persists; then another actor takes the run (cancel / reap / retry).
    const updateOne = vi.fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValue({ matchedCount: 0 });
    const { processMultiTurn } = makeHarness(updateOne);
    const reachedThirdTurn = vi.fn();
    runGatedLoop.mockImplementation(async (config: any) => {
      await config.onTurnComplete(turn(1));
      await config.onTurnComplete(turn(2));
      reachedThirdTurn();
      return { turns: [], passed: false, hadError: false, finalResult: "" };
    });

    const error = await processMultiTurn().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RunOwnershipLostError);
    expect((error as Error).message).toMatch(/run run-1.*iteration 2/);
    expect(reachedThirdTurn).not.toHaveBeenCalled();
    expect(updateOne.mock.calls.some(([, u]) => u.$set?.["run.status"] === "done")).toBe(false);
  });
});

describe("updateOwnedRun", () => {
  it("treats a result without matchedCount as success", async () => {
    const updateOne = vi.fn().mockResolvedValue({});
    const { qp } = makeHarness(updateOne);

    await expect((qp as any).updateOwnedRun("req-1", "run-1", { $set: { x: 1 } }, "x")).resolves.toBeUndefined();
  });
});
