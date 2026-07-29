// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaseQueueProcessor } from "./base-queue-processor.js";
import type { VisibilityHeartbeat } from "./visibility-heartbeat.js";
import type { BaseQueueProcessorConfig, LogEvent } from "@scope/core";
import type { DequeuedMessageItem } from "@azure/storage-queue";

// Minimal config for testing (connections are mocked)
const testConfig: BaseQueueProcessorConfig = {
  mongoUri: "mongodb://localhost:27017",
  mongoDatabase: "test-db",
  mongoCollection: "test-collection",
  storageAccountName: "devstoreaccount1",
  storageConnectionString:
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;",
  queueName: "test-queue",
  batchSize: 1,
  pollIntervalMs: 50,
  redisHost: "localhost",
  redisPort: 6379,
  redisPassword: "",
};

// Concrete subclass to test the abstract base
class TestQueueProcessor extends BaseQueueProcessor<{ _id: string; status: string }> {
  public handleRequestCalls: string[] = [];
  public handleRequestDelay = 0;
  public cleanupCalled = false;

  protected async handleRequest(
    doc: { _id: string; status: string },
    _message: DequeuedMessageItem,
    _heartbeat: VisibilityHeartbeat,
    _log: (level: LogEvent["level"], msg: string, data?: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    this.handleRequestCalls.push(doc._id);
    if (this.handleRequestDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.handleRequestDelay));
    }
  }

  protected override async cleanup(): Promise<void> {
    this.cleanupCalled = true;
    // Don't call super.cleanup() in tests — no real connections to close
  }

  // Expose private state for testing
  get isStopping(): boolean {
    return (this as any).stopping;
  }

  // Allow tests to trigger a graceful stop without sending real signals
  requestStop(): void {
    (this as any).stopping = true;
  }
}

describe("BaseQueueProcessor graceful shutdown", () => {
  let processor: TestQueueProcessor;
  const originalExit = process.exit;

  beforeEach(() => {
    processor = new TestQueueProcessor(testConfig, "test-worker");
    // Prevent process.exit from actually exiting during tests
    process.exit = vi.fn() as any;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("stopping flag defaults to false", () => {
    expect(processor.isStopping).toBe(false);
  });

  it("requestStop sets stopping flag to true", () => {
    processor.requestStop();
    expect(processor.isStopping).toBe(true);
  });

  it("poll loop exits when stopping is set before start", async () => {
    // Mock external dependencies so start() doesn't fail on connection
    const mockQueueClient = {
      createIfNotExists: vi.fn().mockResolvedValue(undefined),
      receiveMessages: vi.fn().mockResolvedValue({ receivedMessageItems: [] }),
    };
    const mockMongoClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      db: vi.fn().mockReturnValue({
        collection: vi.fn().mockReturnValue({}),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    // Replace internal clients with mocks
    (processor as any).queueClient = mockQueueClient;
    (processor as any).mongoClient = mockMongoClient;
    (processor as any).logPublisher = { close: vi.fn().mockResolvedValue(undefined) };

    // Set stopping before start — the poll loop should exit immediately
    processor.requestStop();

    await processor.start();

    // The poll loop should have exited, cleanup should have been called
    expect(processor.cleanupCalled).toBe(true);
    // receiveMessages should never have been called since we stopped before polling
    expect(mockQueueClient.receiveMessages).not.toHaveBeenCalled();
  });

  it("poll loop exits after processing current batch when stop is requested", async () => {
    let pollCount = 0;

    const mockQueueClient = {
      createIfNotExists: vi.fn().mockResolvedValue(undefined),
      receiveMessages: vi.fn().mockImplementation(async () => {
        pollCount++;
        if (pollCount >= 2) {
          // Stop after 2nd poll
          processor.requestStop();
        }
        return { receivedMessageItems: [] };
      }),
    };
    const mockMongoClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      db: vi.fn().mockReturnValue({
        collection: vi.fn().mockReturnValue({}),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (processor as any).queueClient = mockQueueClient;
    (processor as any).mongoClient = mockMongoClient;
    (processor as any).logPublisher = { close: vi.fn().mockResolvedValue(undefined) };

    await processor.start();

    expect(pollCount).toBe(2);
    expect(processor.cleanupCalled).toBe(true);
  });
});

/**
 * These tests cover the visibility-heartbeat lifecycle around handleRequest:
 *   - the heartbeat is started before handleRequest runs (so pre-handler work
 *     like MCP/skill resolution is covered)
 *   - the live heartbeat is the one passed to handleRequest
 *   - on success the base class stops the heartbeat after handleRequest
 *     returns, freezing the pop receipt
 *   - on error the base class stops the heartbeat and uses the latest
 *     pop receipt for safeDeleteMessage (not the original message.popReceipt)
 */
describe("BaseQueueProcessor visibility heartbeat lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeMessage(): DequeuedMessageItem {
    const payload = Buffer.from(JSON.stringify({ requestId: "doc-1" })).toString("base64");
    return {
      messageId: "msg-1",
      popReceipt: "receipt-0",
      messageText: payload,
    } as unknown as DequeuedMessageItem;
  }

  function setupProcessor(handleRequest: (heartbeat: VisibilityHeartbeat) => Promise<void> | void) {
    class HBProcessor extends BaseQueueProcessor<{ _id: string }> {
      public capturedHeartbeat: VisibilityHeartbeat | undefined;
      public handleRequestCalls = 0;
      public popReceiptAtHandleStart: string | undefined;

      protected async handleRequest(
        _doc: { _id: string },
        _message: DequeuedMessageItem,
        heartbeat: VisibilityHeartbeat,
      ): Promise<void> {
        this.capturedHeartbeat = heartbeat;
        this.popReceiptAtHandleStart = heartbeat.popReceipt;
        this.handleRequestCalls++;
        await handleRequest(heartbeat);
      }

      protected override async cleanup(): Promise<void> {
        // no-op
      }
    }

    const proc = new HBProcessor(testConfig, "test-worker");
    const updateMessage = vi.fn().mockImplementation((_id, _r, _t, _v) =>
      Promise.resolve({ popReceipt: `receipt-${updateMessage.mock.calls.length}` }),
    );
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    (proc as any).queueClient = { updateMessage, deleteMessage };
    (proc as any).collection = {
      findOne: vi.fn().mockResolvedValue({ _id: "doc-1", run: { _id: "run-1" } }),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    (proc as any).logPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
      evictRun: vi.fn(),
    };
    return { proc, updateMessage, deleteMessage };
  }

  it("starts the heartbeat before handleRequest runs", async () => {
    const { proc, updateMessage } = setupProcessor(async () => {});
    await (proc as any).processMessage(makeMessage());

    // handleRequest captured a real heartbeat
    expect(proc.capturedHeartbeat).toBeDefined();
    expect(proc.popReceiptAtHandleStart).toBe("receipt-0");
    // The heartbeat is created with the original receipt; no tick yet because
    // handleRequest returns synchronously here. updateMessage should not have
    // been called for a fast handler.
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it("the heartbeat passed to handleRequest exposes the live pop receipt", async () => {
    let observedAfterTick: string | undefined;
    const { proc } = setupProcessor(async (heartbeat) => {
      // Let the heartbeat tick once during the handler
      await vi.advanceTimersByTimeAsync(20_000);
      observedAfterTick = heartbeat.popReceipt;
    });
    await (proc as any).processMessage(makeMessage());

    expect(observedAfterTick).toBe("receipt-1");
  });

  it("uses the latest pop receipt for safeDeleteMessage on error path", async () => {
    const { proc, deleteMessage } = setupProcessor(async () => {
      // Tick the heartbeat once, then throw
      await vi.advanceTimersByTimeAsync(20_000);
      throw new Error("handler boom");
    });
    await (proc as any).processMessage(makeMessage());

    // Error path delete must use the receipt the heartbeat advanced to,
    // not the original "receipt-0".
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith("msg-1", "receipt-1");
  });

  it("stops the heartbeat after handleRequest returns (no further updateMessage calls)", async () => {
    const { proc, updateMessage } = setupProcessor(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await (proc as any).processMessage(makeMessage());

    const callsAfterReturn = updateMessage.mock.calls.length;
    // Advance time well past several intervals — no further ticks should fire
    await vi.advanceTimersByTimeAsync(120_000);
    expect(updateMessage.mock.calls.length).toBe(callsAfterReturn);
  });

  it("stops the heartbeat when handleRequest throws (no further updateMessage calls)", async () => {
    const { proc, updateMessage } = setupProcessor(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      throw new Error("boom");
    });
    await (proc as any).processMessage(makeMessage());

    const callsAfterThrow = updateMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(updateMessage.mock.calls.length).toBe(callsAfterThrow);
  });
});
