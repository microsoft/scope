// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestDocument } from "shared";
import { PostProcessor } from "./post-processor.js";
import type { PostProcessHandler, PostProcessorMessage } from "./types.js";

const CONFIG = {
  mongoUri: "mongodb://localhost:27017",
  mongoDatabase: "requests-db",
  mongoCollection: "requests",
  storageAccountName: "devstoreaccount1",
  storageConnectionString: "UseDevelopmentStorage=true",
  queueName: "post-processor-queue",
  batchSize: 1,
  pollIntervalMs: 5000,
  redisHost: "localhost",
  redisPort: 6379,
  redisPassword: "",
};

function makeDoc(overrides: Partial<RequestDocument["run"]> = {}): RequestDocument {
  return {
    _id: "req-1",
    projectId: "project",
    scenario: { task: "task", criteria: [] },
    workerType: "post-processor",
    createdAt: new Date(),
    priority: 0,
    run: {
      _id: "run-1",
      attemptNumber: 1,
      status: "done",
      handlerStatus: {},
      ...overrides,
    },
  };
}

function makeProcessor() {
  const processor = new PostProcessor(CONFIG);
  const collection = {
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  };
  const blobStorage = {};

  (processor as any).collection = collection;
  (processor as any).blobStorage = blobStorage;
  (processor as any).db = {
    collection: vi.fn().mockReturnValue({}),
  };

  const safeDeleteMessage = vi
    .spyOn(processor as any, "safeDeleteMessage")
    .mockResolvedValue(undefined);
  const notifyHandlerComplete = vi
    .spyOn(processor as any, "notifyHandlerComplete")
    .mockResolvedValue(undefined);

  return { processor, collection, blobStorage, safeDeleteMessage, notifyHandlerComplete };
}

function makeMessage(messageId = "message-1") {
  return {
    messageId,
    popReceipt: "pop-0",
  } as any;
}

function makeHeartbeat() {
  return {
    popReceipt: "pop-0",
    stop: vi.fn().mockReturnValue("pop-1"),
  } as any;
}

describe("PostProcessor", () => {
  let handler: PostProcessHandler;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = {
      type: "atif",
      version: 1,
      autoBackfill: true,
      process: vi.fn().mockResolvedValue(undefined),
    };
    log = vi.fn().mockResolvedValue(undefined);
  });

  it("discards stale messages for an older run attempt", async () => {
    const { processor, collection, safeDeleteMessage } = makeProcessor();
    processor.registerHandler(handler);

    const doc = makeDoc({ _id: "run-2" });
    const heartbeat = makeHeartbeat();
    const payload: PostProcessorMessage = { type: "atif", requestId: "req-1", runId: "run-1" };

    await (processor as any).handleRequest(doc, makeMessage(), heartbeat, log, payload);

    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(handler.process).not.toHaveBeenCalled();
    expect(safeDeleteMessage).toHaveBeenCalledWith("message-1", "pop-1");
  });

  it("no-ops duplicate messages when the handler is already current", async () => {
    const { processor, collection, safeDeleteMessage, notifyHandlerComplete } = makeProcessor();
    processor.registerHandler(handler);

    const doc = makeDoc({
      handlerStatus: {
        "pp-atif": { status: "done", version: 1, updatedAt: new Date() },
      },
    });
    const heartbeat = makeHeartbeat();
    const payload: PostProcessorMessage = { type: "atif", requestId: "req-1", runId: "run-1" };

    collection.findOneAndUpdate.mockResolvedValue(null);

    await (processor as any).handleRequest(doc, makeMessage(), heartbeat, log, payload);

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "req-1",
        "run._id": "run-1",
        "run.status": "done",
        "run.handlerStatus.pp-atif.status": { $nin: ["processing"] },
        $or: [
          { "run.handlerStatus.pp-atif.version": { $exists: false } },
          { "run.handlerStatus.pp-atif.version": { $lt: 1 } },
        ],
      }),
      expect.any(Object),
      expect.objectContaining({ returnDocument: "after" }),
    );
    expect(handler.process).not.toHaveBeenCalled();
    expect(collection.updateOne).not.toHaveBeenCalled();
    expect(notifyHandlerComplete).not.toHaveBeenCalled();
    expect(safeDeleteMessage).toHaveBeenCalledWith("message-1", "pop-1");
  });

  it("re-processes stale versions and stamps success for the same run attempt", async () => {
    const { processor, collection, safeDeleteMessage, notifyHandlerComplete } = makeProcessor();
    processor.registerHandler(handler);

    const doc = makeDoc({
      handlerStatus: {
        "pp-atif": { status: "done", version: 0, updatedAt: new Date() },
      },
    });
    const heartbeat = makeHeartbeat();
    const payload: PostProcessorMessage = { type: "atif", requestId: "req-1", runId: "run-1" };

    collection.findOneAndUpdate.mockResolvedValue({ _id: "req-1" });
    collection.updateOne.mockResolvedValue({ matchedCount: 1 });

    await (processor as any).handleRequest(doc, makeMessage(), heartbeat, log, payload);

    expect(handler.process).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({
        blobStorage: expect.any(Object),
        collection,
        log,
      }),
    );
    expect(collection.updateOne).toHaveBeenCalledWith(
      {
        _id: "req-1",
        "run._id": "run-1",
        "run.handlerStatus.pp-atif.status": "processing",
      },
      {
        $set: expect.objectContaining({
          "run.postProcessorVersion": 1,
          "run.postProcessorStatus": "done",
          "run.handlerStatus.pp-atif.status": "done",
          "run.handlerStatus.pp-atif.version": 1,
          "run.handlerStatus.pp-atif.updatedAt": expect.any(Date),
        }),
      },
    );
    expect(notifyHandlerComplete).toHaveBeenCalledWith("req-1", "run-1", "pp-atif", "done");
    expect(safeDeleteMessage).toHaveBeenCalledWith("message-1", "pop-1");
  });

  it("claims a run left in the scheduler's 'queued' state and drives it to done", async () => {
    // Regression: the scheduler writes a best-effort "queued" marker right after
    // enqueue-before-claim, so a dequeued message almost always sees status
    // "queued". The worker MUST be able to claim it (queued -> processing).
    // Previously "queued" was in the claim exclusion list, so the worker
    // discarded its own message and stranded the run at "queued" forever.
    const { processor, collection, safeDeleteMessage, notifyHandlerComplete } = makeProcessor();
    processor.registerHandler(handler);

    const doc = makeDoc({
      handlerStatus: {
        "pp-atif": { status: "queued", updatedAt: new Date() },
      },
    });
    const heartbeat = makeHeartbeat();
    const payload: PostProcessorMessage = { type: "atif", requestId: "req-1", runId: "run-1" };

    collection.findOneAndUpdate.mockResolvedValue({ _id: "req-1" });
    collection.updateOne.mockResolvedValue({ matchedCount: 1 });

    await (processor as any).handleRequest(doc, makeMessage(), heartbeat, log, payload);

    // The claim filter must NOT exclude "queued" — only "processing".
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "req-1",
        "run._id": "run-1",
        "run.status": "done",
        "run.handlerStatus.pp-atif.status": { $nin: ["processing"] },
      }),
      expect.any(Object),
      expect.objectContaining({ returnDocument: "after" }),
    );
    expect(handler.process).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ collection, log }),
    );
    expect(collection.updateOne).toHaveBeenCalledWith(
      {
        _id: "req-1",
        "run._id": "run-1",
        "run.handlerStatus.pp-atif.status": "processing",
      },
      {
        $set: expect.objectContaining({
          "run.handlerStatus.pp-atif.status": "done",
          "run.handlerStatus.pp-atif.version": 1,
        }),
      },
    );
    expect(notifyHandlerComplete).toHaveBeenCalledWith("req-1", "run-1", "pp-atif", "done");
    expect(safeDeleteMessage).toHaveBeenCalledWith("message-1", "pop-1");
  });
});
