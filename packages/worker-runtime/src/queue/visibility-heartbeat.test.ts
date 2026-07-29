// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startVisibilityHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_VISIBILITY_SECONDS,
  type VisibilityHeartbeat,
} from "./visibility-heartbeat.js";
import type { QueueClient } from "@azure/storage-queue";

/**
 * Test the standalone visibility heartbeat function.
 */

function createMockQueueClient(): QueueClient {
  return {
    updateMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueueClient;
}

describe("visibility heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the initial pop receipt before any tick", () => {
    const qc = createMockQueueClient();
    const hb = startVisibilityHeartbeat(qc, "msg-1", "receipt-0", "test-worker", 30_000, 120);
    expect(hb.popReceipt).toBe("receipt-0");
    hb.stop();
  });

  it("calls updateMessage after the interval", async () => {
    const qc = createMockQueueClient();
    (qc.updateMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ popReceipt: "receipt-1" });

    const hb = startVisibilityHeartbeat(qc, "msg-1", "receipt-0", "test-worker", 100, 120);

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(150);

    expect(qc.updateMessage).toHaveBeenCalledTimes(1);
    expect(qc.updateMessage).toHaveBeenCalledWith("msg-1", "receipt-0", undefined, 120);
    expect(hb.popReceipt).toBe("receipt-1");

    hb.stop();
  });

  it("chains pop receipts across multiple ticks", async () => {
    const qc = createMockQueueClient();
    let callCount = 0;
    (qc.updateMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      return Promise.resolve({ popReceipt: `receipt-${callCount}` });
    });

    const hb = startVisibilityHeartbeat(qc, "msg-1", "receipt-0", "test-worker", 100, 120);

    // Tick 1
    await vi.advanceTimersByTimeAsync(150);
    expect(hb.popReceipt).toBe("receipt-1");
    expect(qc.updateMessage).toHaveBeenLastCalledWith("msg-1", "receipt-0", undefined, 120);

    // Tick 2
    await vi.advanceTimersByTimeAsync(100);
    expect(hb.popReceipt).toBe("receipt-2");
    expect(qc.updateMessage).toHaveBeenLastCalledWith("msg-1", "receipt-1", undefined, 120);

    hb.stop();
  });

  it("stop() is idempotent and returns latest pop receipt", async () => {
    const qc = createMockQueueClient();
    (qc.updateMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ popReceipt: "receipt-1" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const hb = startVisibilityHeartbeat(qc, "msg-1", "receipt-0", "test-worker", 100, 120);

    await vi.advanceTimersByTimeAsync(150);
    const first = hb.stop();
    const second = hb.stop();
    expect(first).toBe("receipt-1");
    expect(second).toBe("receipt-1");

    // Only one "stopped" log line should be emitted, even though stop()
    // was called twice (subclass + base-class defensive cleanup).
    const stopLogs = logSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("Visibility heartbeat stopped"),
    );
    expect(stopLogs).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("does not call updateMessage after stop", async () => {
    const qc = createMockQueueClient();
    (qc.updateMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ popReceipt: "receipt-1" });

    const hb = startVisibilityHeartbeat(qc, "msg-1", "receipt-0", "test-worker", 100, 120);
    hb.stop();

    await vi.advanceTimersByTimeAsync(500);
    expect(qc.updateMessage).not.toHaveBeenCalled();
  });

  it("survives an updateMessage failure and retries on next tick", async () => {
    const qc = createMockQueueClient();
    (qc.updateMessage as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("transient 409"))
      .mockResolvedValueOnce({ popReceipt: "receipt-2" });

    const hb = startVisibilityHeartbeat(qc, "msg-1", "receipt-0", "test-worker", 100, 120);

    // Tick 1 — fails, pop receipt stays at receipt-0
    await vi.advanceTimersByTimeAsync(150);
    expect(hb.popReceipt).toBe("receipt-0");

    // Tick 2 — succeeds with the same receipt-0 (since tick 1 failed)
    await vi.advanceTimersByTimeAsync(100);
    expect(qc.updateMessage).toHaveBeenCalledTimes(2);
    expect(qc.updateMessage).toHaveBeenLastCalledWith("msg-1", "receipt-0", undefined, 120);
    expect(hb.popReceipt).toBe("receipt-2");

    hb.stop();
  });

  it("exports correct default constants", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(HEARTBEAT_VISIBILITY_SECONDS).toBe(60);
  });

  it("logs start and stop with tick count", async () => {
    const qc = createMockQueueClient();
    (qc.updateMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ popReceipt: "receipt-1" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const hb = startVisibilityHeartbeat(qc, "msg-1", "receipt-0", "test-worker", 100, 120);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Visibility heartbeat started"),
    );

    await vi.advanceTimersByTimeAsync(150);
    hb.stop();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Visibility heartbeat stopped after 1 tick(s)"),
    );

    logSpy.mockRestore();
  });
});
