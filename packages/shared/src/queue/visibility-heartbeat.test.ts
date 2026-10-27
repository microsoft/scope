// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startVisibilityHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_VISIBILITY_SECONDS,
  HEARTBEAT_REQUEST_TIMEOUT_MS,
  HeartbeatRequestTimeoutError,
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
    expect(qc.updateMessage).toHaveBeenCalledWith("msg-1", "receipt-0", undefined, 120, { abortSignal: expect.any(AbortSignal) });
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
    expect(qc.updateMessage).toHaveBeenLastCalledWith("msg-1", "receipt-0", undefined, 120, { abortSignal: expect.any(AbortSignal) });

    // Tick 2
    await vi.advanceTimersByTimeAsync(100);
    expect(hb.popReceipt).toBe("receipt-2");
    expect(qc.updateMessage).toHaveBeenLastCalledWith("msg-1", "receipt-1", undefined, 120, { abortSignal: expect.any(AbortSignal) });

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
    expect(qc.updateMessage).toHaveBeenLastCalledWith("msg-1", "receipt-0", undefined, 120, { abortSignal: expect.any(AbortSignal) });
    expect(hb.popReceipt).toBe("receipt-2");

    hb.stop();
  });

  it("fires the liveness onTick on a dedicated interval even when updateMessage keeps failing", async () => {
    const qc = createMockQueueClient();
    // Visibility extension fails on every tick — liveness must still fire.
    (qc.updateMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("transient 500"));
    const onTick = vi.fn().mockResolvedValue(undefined);

    const hb = startVisibilityHeartbeat(
      qc, "msg-1", "receipt-0", "test-worker", 100, 120, {}, onTick,
    );

    await vi.advanceTimersByTimeAsync(350);

    // updateMessage failed every time, but liveness kept beating.
    expect(qc.updateMessage).toHaveBeenCalled();
    expect(onTick).toHaveBeenCalledTimes(3);
    expect(onTick).toHaveBeenLastCalledWith({ tickCount: 3 });

    hb.stop();
  });

  it("keeps beating liveness when a single onTick rejects (and does not abort)", async () => {
    const qc = createMockQueueClient();
    (qc.updateMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ popReceipt: "receipt-1" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onTick = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis blip"))
      .mockResolvedValue(undefined);

    const hb = startVisibilityHeartbeat(
      qc, "msg-1", "receipt-0", "test-worker", 100, 120, {}, onTick,
    );

    await vi.advanceTimersByTimeAsync(250);

    expect(onTick).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Liveness heartbeat tick failed"),
      expect.any(Error),
    );

    hb.stop();
    warnSpy.mockRestore();
  });

  it("does not fire onTick after stop", async () => {
    const qc = createMockQueueClient();
    (qc.updateMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ popReceipt: "receipt-1" });
    const onTick = vi.fn().mockResolvedValue(undefined);

    const hb = startVisibilityHeartbeat(
      qc, "msg-1", "receipt-0", "test-worker", 100, 120, {}, onTick,
    );
    hb.stop();

    await vi.advanceTimersByTimeAsync(500);
    expect(onTick).not.toHaveBeenCalled();
  });

  it("exports correct default constants", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(HEARTBEAT_VISIBILITY_SECONDS).toBe(60);
    expect(HEARTBEAT_REQUEST_TIMEOUT_MS).toBeLessThan(HEARTBEAT_INTERVAL_MS);
  });

  it("reports a hung updateMessage as a failed tick and keeps beating (#805)", async () => {
    const qc = createMockQueueClient();
    const signals: AbortSignal[] = [];
    // First call never settles (frozen endpoint); the second succeeds.
    (qc.updateMessage as ReturnType<typeof vi.fn>)
      .mockImplementationOnce((_id, _receipt, _text, _visibility, options) => {
        signals.push(options.abortSignal);
        return new Promise(() => {});
      })
      .mockResolvedValue({ popReceipt: "receipt-1" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const hb = startVisibilityHeartbeat(
      qc, "msg-1", "receipt-0", "test-worker", 100, 120, {}, undefined, 50,
    );

    // Tick 1 starts at 100ms and times out at 150ms.
    await vi.advanceTimersByTimeAsync(160);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Visibility heartbeat tick failed (1 consecutive)"),
      expect.any(HeartbeatRequestTimeoutError),
    );
    expect(signals[0].aborted).toBe(true);

    // Tick 2 starts 100ms after the timeout and succeeds.
    await vi.advanceTimersByTimeAsync(100);
    expect(qc.updateMessage).toHaveBeenCalledTimes(2);
    expect(hb.popReceipt).toBe("receipt-1");

    hb.stop();
    warnSpy.mockRestore();
  });

  it("cancels an in-flight updateMessage when stopped", async () => {
    const qc = createMockQueueClient();
    let signal: AbortSignal | undefined;
    (qc.updateMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (_id, _receipt, _text, _visibility, options) => {
        signal = options.abortSignal;
        return new Promise(() => {});
      },
    );

    const hb = startVisibilityHeartbeat(qc, "msg-1", "receipt-0", "test-worker", 100, 120);
    await vi.advanceTimersByTimeAsync(150);
    expect(signal?.aborted).toBe(false);

    hb.stop();
    expect(signal?.aborted).toBe(true);
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
