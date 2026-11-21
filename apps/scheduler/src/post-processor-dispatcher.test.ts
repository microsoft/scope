// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostProcessorDispatcher } from "./post-processor-dispatcher.js";

function createMockCollection() {
  return {
    findOneAndUpdate: vi.fn(),
  } as any;
}

function createMockDb() {
  const findOne = vi.fn();
  return {
    collection: vi.fn().mockReturnValue({ findOne }),
    _findOne: findOne,
  } as any;
}

function createMockQueueClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    createIfNotExists: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("PostProcessorDispatcher", () => {
  let collection: ReturnType<typeof createMockCollection>;
  let db: ReturnType<typeof createMockDb>;
  let queueClient: ReturnType<typeof createMockQueueClient>;

  beforeEach(() => {
    collection = createMockCollection();
    db = createMockDb();
    queueClient = createMockQueueClient();
  });

  it("does not dispatch when no version is registered", async () => {
    db._findOne.mockResolvedValue(null);

    const dispatcher = new PostProcessorDispatcher(collection, db, queueClient, 60_000);
    // Access private dispatch method via any
    await (dispatcher as any).dispatch();

    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(queueClient.sendMessage).not.toHaveBeenCalled();
  });

  it("dispatches a completed run needing processing", async () => {
    db._findOne.mockResolvedValue({ _id: "post-processor", version: 1 });
    collection.findOneAndUpdate
      .mockResolvedValueOnce({ _id: "req-1", run: { _id: "run-1" } })
      .mockResolvedValueOnce(null); // no more

    const dispatcher = new PostProcessorDispatcher(collection, db, queueClient, 60_000);
    await (dispatcher as any).dispatch();

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "run.status": "done",
        "run.postProcessorStatus": { $nin: ["queued", "processing"] },
      }),
      expect.objectContaining({
        $set: { "run.postProcessorStatus": "queued" },
      }),
      expect.objectContaining({
        sort: { updatedAt: -1 },
        returnDocument: "after",
      }),
    );

    expect(queueClient.sendMessage).toHaveBeenCalledTimes(1);
    const sentMessage = queueClient.sendMessage.mock.calls[0][0];
    const decoded = JSON.parse(Buffer.from(sentMessage, "base64").toString("utf-8"));
    expect(decoded).toEqual({
      type: "atif",
      requestId: "req-1",
      runId: "run-1",
    });
  });

  it("dispatches multiple runs up to batchSize", async () => {
    db._findOne.mockResolvedValue({ _id: "post-processor", version: 2 });
    collection.findOneAndUpdate
      .mockResolvedValueOnce({ _id: "req-1", run: { _id: "run-1" } })
      .mockResolvedValueOnce({ _id: "req-2", run: { _id: "run-2" } })
      .mockResolvedValueOnce(null);

    const dispatcher = new PostProcessorDispatcher(collection, db, queueClient, 60_000, 5);
    await (dispatcher as any).dispatch();

    expect(queueClient.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("stops dispatching when no claims are returned", async () => {
    db._findOne.mockResolvedValue({ _id: "post-processor", version: 1 });
    collection.findOneAndUpdate.mockResolvedValue(null);

    const dispatcher = new PostProcessorDispatcher(collection, db, queueClient, 60_000);
    await (dispatcher as any).dispatch();

    expect(queueClient.sendMessage).not.toHaveBeenCalled();
  });

  it("rolls back status when queue send fails", async () => {
    db._findOne.mockResolvedValue({ _id: "post-processor", version: 1 });
    collection.findOneAndUpdate
      .mockResolvedValueOnce({ _id: "req-1", run: { _id: "run-1" } })
      .mockResolvedValueOnce({ _id: "req-2", run: { _id: "run-2" } });
    collection.updateOne = vi.fn().mockResolvedValue({});
    queueClient.sendMessage.mockRejectedValueOnce(new Error("queue unavailable"));

    const dispatcher = new PostProcessorDispatcher(collection, db, queueClient, 60_000, 5);
    await (dispatcher as any).dispatch();

    // Should have rolled back status for req-1
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: "req-1", "run._id": "run-1", "run.postProcessorStatus": "queued" },
      { $unset: { "run.postProcessorStatus": "" } },
    );
    // Should have stopped the batch (req-2 never sent)
    expect(queueClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { runId: "run-2", status: "queued", reason: "a newer attempt was queued" },
    { runId: "run-1", status: "processing", reason: "the worker already claimed the message" },
    { runId: "run-1", status: "done", reason: "the worker already completed the message" },
  ])("preserves status after a send failure when $reason", async ({ runId, status }) => {
    db._findOne.mockResolvedValue({ _id: "post-processor", version: 1 });
    collection.findOneAndUpdate.mockResolvedValueOnce({
      _id: "req-1", run: { _id: "run-1", postProcessorStatus: "queued" },
    });

    // Model a retry or delivery racing the failed send. Apply the rollback
    // only if its Mongo predicates match the document that exists now.
    const current: Record<string, string> = {
      _id: "req-1", "run._id": runId, "run.postProcessorStatus": status,
    };
    collection.updateOne = vi.fn(async (filter: Record<string, unknown>) => {
      const matches = Object.entries(filter).every(([key, value]) => current[key] === value);
      if (matches) delete current["run.postProcessorStatus"];
      return { matchedCount: matches ? 1 : 0 };
    });
    queueClient.sendMessage.mockRejectedValueOnce(new Error("send acknowledgement lost"));

    const dispatcher = new PostProcessorDispatcher(collection, db, queueClient, 60_000);
    await (dispatcher as any).dispatch();

    expect(collection.updateOne).toHaveBeenCalledOnce();
    expect(current["run.postProcessorStatus"]).toBe(status);
    expect(queueClient.sendMessage).toHaveBeenCalledTimes(1);
  });
});
