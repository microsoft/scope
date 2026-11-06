// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEvent } from "../types/types.js";

// ─── Import after mocks ────────────────────────────────────────────────────

const { LogPublisher } = await import("./log-publisher.js");

// ─── Mock objects ──────────────────────────────────────────────────────────

// ioredis is loaded via createRequire() so vi.mock("ioredis") is bypassed.
// We replace the redis instance on each publisher after construction.

const mockRedis = {
  publish: vi.fn().mockResolvedValue(1),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  disconnect: vi.fn(),
};

const mockAppendLogEvent = vi.fn().mockResolvedValue(undefined);

const mockBlobStorage = {
  appendLogEvent: mockAppendLogEvent,
} as any;

// ─── Helpers ───────────────────────────────────────────────────────────────

function makePublisher() {
  const publisher = new LogPublisher(
    { redisHost: "127.0.0.1", redisPort: 1, redisPassword: "" },
    mockBlobStorage,
    "test-worker",
  );
  // vi.mock("ioredis") doesn't intercept createRequire-based CJS imports.
  // Disconnect the real ioredis instance to stop background reconnection,
  // then replace both redis and the circuit breaker with synchronous mocks.
  (publisher as any).redis?.disconnect?.();
  (publisher as any).redis = mockRedis;
  (publisher as any).redisBreaker = {
    execute: async (fn: () => Promise<unknown>) => fn(),
    state: "closed",
    onStateChange: vi.fn(),
  };
  return publisher;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("LogPublisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendLogEvent.mockResolvedValue(undefined);
    mockRedis.publish.mockResolvedValue(1);
  });

  describe("publish()", () => {
    it("publishes to Redis on the correct channel", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "attempt-1", "info", "hello");

      expect(mockRedis.publish).toHaveBeenCalledOnce();
      const [channel, payload] = mockRedis.publish.mock.calls[0];
      expect(channel).toBe("logs:run-abc");
      const parsed = JSON.parse(payload);
      expect(parsed.message).toBe("hello");
      expect(parsed.level).toBe("info");
      expect(parsed.source).toBe("test-worker");
    });

    it("persists the log event via appendLogEvent under the per-attempt path", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "attempt-1", "warn", "something happened");

      expect(mockAppendLogEvent).toHaveBeenCalledOnce();
      const [requestId, runId, event] = mockAppendLogEvent.mock.calls[0];
      expect(requestId).toBe("run-abc");
      expect(runId).toBe("attempt-1");
      expect(event.message).toBe("something happened");
      expect(event.level).toBe("warn");
    });

    it("includes optional data in the persisted log event", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "attempt-1", "info", "msg", { key: "value" });

      const event: LogEvent = mockAppendLogEvent.mock.calls[0][2];
      expect(event.data).toEqual({ key: "value" });
    });

    it("does not throw when Redis publish fails", async () => {
      mockRedis.publish.mockRejectedValue(new Error("Redis connection refused"));
      const publisher = makePublisher();

      await expect(publisher.publish("run-abc", "attempt-1", "info", "msg")).resolves.toBeUndefined();
      expect(mockAppendLogEvent).toHaveBeenCalledOnce();
    });

    it("does not throw when blob storage append fails", async () => {
      const err = Object.assign(new Error("BlobServiceError"), { statusCode: 500 });
      mockAppendLogEvent.mockRejectedValue(err);
      const publisher = makePublisher();

      await expect(publisher.publish("run-abc", "attempt-1", "info", "msg")).resolves.toBeUndefined();
    });
  });

  describe("secret redaction (#1141)", () => {
    // Assembled at runtime so the source never contains a literal token shape.
    const githubToken = "gh" + "p_" + "a1B2".repeat(9);

    it("redacts secrets in the message and data before both Redis and Blob", async () => {
      const publisher = makePublisher();
      await publisher.publish("run-abc", "attempt-1", "info", `cloning with ${githubToken}`, {
        args: { command: `git push https://x:${githubToken}@github.com/o/r` },
      });

      const streamed = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      const persisted: LogEvent = mockAppendLogEvent.mock.calls[0][2];
      for (const event of [streamed, persisted]) {
        expect(event.message).toBe("cloning with [REDACTED:github-token]");
        expect(event.data).toEqual({ args: { command: "git push https://x:[REDACTED:github-token]@github.com/o/r" } });
      }
    });

    it("redacts secrets published through RedisLogPublisher", async () => {
      const { RedisLogPublisher } = await import("./log-publisher.js");
      const publisher = new RedisLogPublisher({ redisHost: "127.0.0.1", redisPort: 1, redisPassword: "" });
      (publisher as any).redis?.disconnect?.();
      (publisher as any).redis = mockRedis;
      (publisher as any).redisBreaker = { execute: async (fn: () => Promise<unknown>) => fn() };

      await publisher.publish("run-abc", "info", `token ${githubToken}`);

      expect(JSON.parse(mockRedis.publish.mock.calls[0][1]).message).toBe("token [REDACTED:github-token]");
    });
  });

  describe("close()", () => {
    it("calls redis.quit()", async () => {
      const publisher = makePublisher();
      await publisher.close();
      expect(mockRedis.quit).toHaveBeenCalledOnce();
    });
  });
});
