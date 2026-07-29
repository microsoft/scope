// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RequestScheduler, WorkerTypeConfig } from "./request-scheduler.js";
import type { RequestDocument } from "@scope/core";

// ── Mocks ────────────────────────────────────────────────────────────

function makeMockQueueClient(approximateMessagesCount = 0) {
  return {
    getProperties: vi.fn().mockResolvedValue({ approximateMessagesCount }),
    sendMessage: vi.fn().mockResolvedValue({}),
  } as any;
}

function makeMockCollection(docs: RequestDocument[] = []) {
  // Return docs one at a time in order, then null
  let index = 0;
  return {
    findOneAndUpdate: vi.fn().mockImplementation(async () => {
      if (index < docs.length) return docs[index++];
      return null;
    }),
  } as any;
}

function makeDoc(overrides: Partial<RequestDocument> & { _id: string; priority: number }): RequestDocument {
  return {
    scenario: { task: "test", criteria: ["c1"] },
    workerType: "coder-acp-copilot",
    createdAt: new Date(),
    run: { _id: `run-${overrides._id}`, attemptNumber: 1, status: "pending" },
    ...overrides,
  } as RequestDocument;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("RequestScheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches up to targetQueueDepth messages when queue is empty", async () => {
    const doc1 = makeDoc({ _id: "r1", priority: 50 });
    const doc2 = makeDoc({ _id: "r2", priority: 0 });
    const collection = makeMockCollection([doc1, doc2]);
    const queueClient = makeMockQueueClient(0); // empty queue

    const scheduler = new RequestScheduler(
      collection,
      [{ workerType: "coder-acp-copilot", queueClient, targetQueueDepth: 3 }],
    );

    // Manually trigger one dispatch cycle (not using start/interval)
    await (scheduler as any).dispatch();

    // Should have called findOneAndUpdate twice (got 2 docs, then null)
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(3); // 2 found + 1 null
    expect(queueClient.sendMessage).toHaveBeenCalledTimes(2);

    // Verify message payloads
    const msg1 = JSON.parse(Buffer.from(queueClient.sendMessage.mock.calls[0][0], "base64").toString());
    expect(msg1).toEqual({ requestId: "r1", runId: "run-r1" });

    const msg2 = JSON.parse(Buffer.from(queueClient.sendMessage.mock.calls[1][0], "base64").toString());
    expect(msg2).toEqual({ requestId: "r2", runId: "run-r2" });
  });

  it("respects current queue depth and dispatches only remaining slots", async () => {
    const doc1 = makeDoc({ _id: "r1", priority: 0 });
    const collection = makeMockCollection([doc1]);
    const queueClient = makeMockQueueClient(4); // 4 of 5 slots taken

    const scheduler = new RequestScheduler(
      collection,
      [{ workerType: "coder-acp-copilot", queueClient, targetQueueDepth: 5 }],
    );

    await (scheduler as any).dispatch();

    // Only 1 slot available (5 - 4 = 1)
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(queueClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does nothing when queue is at or above target depth", async () => {
    const collection = makeMockCollection([]);
    const queueClient = makeMockQueueClient(5);

    const scheduler = new RequestScheduler(
      collection,
      [{ workerType: "coder-acp-copilot", queueClient, targetQueueDepth: 5 }],
    );

    await (scheduler as any).dispatch();

    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(queueClient.sendMessage).not.toHaveBeenCalled();
  });

  it("queries with correct filter and sort order", async () => {
    const collection = makeMockCollection([]);
    const queueClient = makeMockQueueClient(0);

    const scheduler = new RequestScheduler(
      collection,
      [{ workerType: "coder-acp-copilot", queueClient, targetQueueDepth: 2 }],
    );

    await (scheduler as any).dispatch();

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      {
        "run.status": "pending",
        workerType: "coder-acp-copilot",
        deletedAt: { $exists: false },
      },
      {
        $set: {
          "run.status": "queued",
          "run.updatedAt": expect.any(Date),
        },
      },
      {
        sort: { priority: -1, createdAt: 1 },
        returnDocument: "after",
      },
    );
  });

  it("handles multiple worker types independently", async () => {
    const doc1 = makeDoc({ _id: "r1", priority: 0, workerType: "coder-acp-copilot" });
    const doc2 = makeDoc({ _id: "r2", priority: 0, workerType: "coder-acp-claude-code" });

    // Each collection mock returns one doc then null
    const collection = {
      findOneAndUpdate: vi.fn()
        .mockResolvedValueOnce(doc1)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(doc2)
        .mockResolvedValueOnce(null),
    } as any;

    const queue1 = makeMockQueueClient(0);
    const queue2 = makeMockQueueClient(0);

    const scheduler = new RequestScheduler(
      collection,
      [
        { workerType: "coder-acp-copilot", queueClient: queue1, targetQueueDepth: 3 },
        { workerType: "coder-acp-claude-code", queueClient: queue2, targetQueueDepth: 3 },
      ],
    );

    await (scheduler as any).dispatch();

    expect(queue1.sendMessage).toHaveBeenCalledTimes(1);
    expect(queue2.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("skips a worker type if dispatch throws and continues to next", async () => {
    const doc2 = makeDoc({ _id: "r2", priority: 0 });
    const collection = {
      findOneAndUpdate: vi.fn()
        .mockRejectedValueOnce(new Error("DB error"))
        .mockResolvedValueOnce(doc2)
        .mockResolvedValueOnce(null),
    } as any;

    const queue1 = makeMockQueueClient(0);
    const queue2 = makeMockQueueClient(0);

    const scheduler = new RequestScheduler(
      collection,
      [
        { workerType: "coder-acp-copilot", queueClient: queue1, targetQueueDepth: 3 },
        { workerType: "coder-acp-claude-code", queueClient: queue2, targetQueueDepth: 3 },
      ],
    );

    // Should not throw
    await (scheduler as any).dispatch();

    // First worker type failed, second succeeded
    expect(queue1.sendMessage).not.toHaveBeenCalled();
    expect(queue2.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("start and stop lifecycle", async () => {
    const collection = makeMockCollection([]);
    const queueClient = makeMockQueueClient(0);

    const scheduler = new RequestScheduler(
      collection,
      [{ workerType: "coder-acp-copilot", queueClient, targetQueueDepth: 3 }],
      100, // fast interval for test
    );

    scheduler.start();

    // Wait for a couple of ticks
    await new Promise((r) => setTimeout(r, 350));

    await scheduler.stop();

    // Should have called getProperties multiple times (at least 2-3 ticks)
    expect(queueClient.getProperties.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
