// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import { CodingAgentQueueProcessor } from "./queue-processor.js";
import type { QueueProcessorConfig, WorkerProcessor, WorkerResult } from "@scope/core";
import type { VisibilityHeartbeat } from "./visibility-heartbeat.js";
import { InMemoryHeartbeatStore } from "./heartbeat-store.js";

const testConfig: QueueProcessorConfig = {
  mongoUri: "mongodb://localhost:27017",
  mongoDatabase: "test-db",
  mongoCollection: "test-collection",
  storageAccountName: "devstoreaccount1",
  storageConnectionString:
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=key;QueueEndpoint=http://localhost:10001/devstoreaccount1;",
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

describe("CodingAgentQueueProcessor.getVersionFields", () => {
  it("includes os info with platform, release, and arch", () => {
    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    const fields = (qp as any).getVersionFields();

    expect(fields.os).toEqual({
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    });
  });

  it("includes workerVersion when agentVersion is available", () => {
    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    const fields = (qp as any).getVersionFields();

    expect(fields.workerVersion).toMatch(/^test-1\.0\.0-/);
  });

  it("omits workerVersion when agentVersion is not available", () => {
    const noVersionProcessor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "ok" };
      },
    };
    const qp = new CodingAgentQueueProcessor(testConfig, noVersionProcessor);
    const fields = (qp as any).getVersionFields();

    expect(fields.workerVersion).toBeUndefined();
    expect(fields.os).toBeDefined();
  });

  it("always captures os even without agentVersion", () => {
    const noVersionProcessor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "ok" };
      },
    };
    const qp = new CodingAgentQueueProcessor(testConfig, noVersionProcessor);
    const fields = (qp as any).getVersionFields();

    expect(fields.os.platform).toBe(os.platform());
    expect(fields.os.release).toBe(os.release());
    expect(fields.os.arch).toBe(os.arch());
  });
});

// ─── Redelivery fail-fast (handleRequest pre-checks) ─────────────────────────
describe("CodingAgentQueueProcessor.handleRequest redelivery handling", () => {
  function makeHarness(runStatus: string, runOverrides: Record<string, unknown> = {}) {
    const requestId = "req-1";
    const runId = "run-1";
    const requestDoc = {
      _id: requestId,
      workerType: "coder-acp-copilot",
      scenario: { criteria: [], task: "x" },
      run: { _id: runId, status: runStatus, attemptNumber: 1, ...runOverrides },
    } as any;

    const findOneAndUpdate = vi.fn().mockResolvedValue(requestDoc);
    const collection = { findOneAndUpdate } as any;

    const safeDeleteMessage = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn().mockResolvedValue(undefined);

    const heartbeat: VisibilityHeartbeat = {
      stop: () => "pop-1",
      get popReceipt() { return "pop-1"; },
    };
    const message = { messageId: "msg-1", popReceipt: "pop-1", messageText: "" } as any;

    const heartbeatStore = new InMemoryHeartbeatStore();

    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    (qp as any).collection = collection;
    (qp as any).safeDeleteMessage = safeDeleteMessage;
    (qp as any).heartbeatStore = heartbeatStore;
    // Guard: if the redelivery branch ever falls through, processMultiTurn
    // would be invoked. Stub it so any accidental call is observable.
    (qp as any).processMultiTurn = vi.fn().mockResolvedValue(undefined);

    return { qp, requestDoc, message, heartbeat, log, findOneAndUpdate, safeDeleteMessage, heartbeatStore, runId, requestId };
  }

  it("marks run failed when no heartbeat AND startedAt is older than the staleness threshold", async () => {
    // No Redis heartbeat AND startedAt is way back — this is the legitimate
    // "worker died before its first beat" / "Redis lost the key after a long
    // time" case. Should mark failed.
    const h = makeHarness("processing", {
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    expect(h.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = h.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      _id: h.requestId,
      "run._id": h.runId,
      "run.status": "processing",
    });
    // Atomic claim is now gated on the *current* worker identity (or its
    // absence), not on heartbeat timestamps.
    expect(filter["run.worker"]).toEqual({ $exists: false });
    expect(update.$set["run.status"]).toBe("done");
    expect(update.$set["run.outcome"]).toBe("failed");
    expect(update.$set["run.error"]).toMatch(/Worker presumed dead/);
    expect(update.$set["run.error"]).toMatch(/redelivered/);
    expect(update.$set["run.finishedAt"]).toBeInstanceOf(Date);

    expect(h.safeDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
    expect(h.log).toHaveBeenCalledWith(
      "error",
      expect.stringMatching(/marked failed/),
      expect.objectContaining({ final: true, runId: h.runId }),
    );
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
  });

  it("DROPS duplicate (does not fail run) when no heartbeat but startedAt is recent", async () => {
    // No Redis heartbeat yet AND run was just picked up — this is a
    // transient race (queue redelivered before the first beat fired, or a
    // brief Redis blip). Must NOT fail healthy runs.
    const h = makeHarness("processing", {
      startedAt: new Date(Date.now() - 5_000),
      worker: { instanceId: "worker-X" },
    });

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    expect(h.findOneAndUpdate).not.toHaveBeenCalled();
    expect(h.safeDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(/Duplicate queue message dropped/),
      expect.objectContaining({ runId: h.runId }),
    );
  });

  it("marks run failed when heartbeat is older than the staleness threshold", async () => {
    const h = makeHarness("processing", {
      startedAt: new Date(Date.now() - 15 * 60 * 1000),
      worker: { instanceId: "worker-A", podName: "pod-A" },
    });
    // 10 minutes ago — well past the 120 s default threshold.
    await h.heartbeatStore.set(h.runId, new Date(Date.now() - 10 * 60 * 1000));

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    expect(h.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = h.findOneAndUpdate.mock.calls[0];
    // Claim filter targets the dead worker's identity — if a peer has
    // already taken over (rewriting run.worker.instanceId), the claim
    // no-ops and we drop the dupe instead of double-failing.
    expect(filter["run.worker.instanceId"]).toBe("worker-A");
    expect(update.$set["run.error"]).toMatch(/Worker presumed dead/);
    expect(update.$set["run.error"]).toMatch(/instance=worker-A/);
    expect(update.$set["run.error"]).toMatch(/pod=pod-A/);
    expect(h.safeDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
  });

  it("drops duplicate message WITHOUT touching run state when heartbeat is fresh", async () => {
    const h = makeHarness("processing", {
      startedAt: new Date(Date.now() - 60_000),
      worker: { instanceId: "worker-B", podName: "pod-B" },
    });
    // 5 seconds ago — well within the 120 s threshold.
    await h.heartbeatStore.set(h.runId, new Date(Date.now() - 5_000));

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    // Critical: no DB write — the original worker keeps its run state.
    expect(h.findOneAndUpdate).not.toHaveBeenCalled();
    expect(h.safeDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(/Duplicate queue message dropped.*worker-B/),
      expect.objectContaining({ runId: h.runId }),
    );
    const finalCalls = h.log.mock.calls.filter((c: any[]) => c[2]?.final);
    expect(finalCalls).toHaveLength(0);
  });

  it("respects SCOPE_RUN_HEARTBEAT_STALE_MS override", async () => {
    const prev = process.env.SCOPE_RUN_HEARTBEAT_STALE_MS;
    process.env.SCOPE_RUN_HEARTBEAT_STALE_MS = "1000"; // 1 s
    try {
      const h = makeHarness("processing", {
        startedAt: new Date(Date.now() - 60_000),
        worker: { instanceId: "worker-C" },
      });
      // 5 s ago — fresh under the default 120 s, but stale under 1 s.
      await h.heartbeatStore.set(h.runId, new Date(Date.now() - 5_000));

      await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

      expect(h.findOneAndUpdate).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.SCOPE_RUN_HEARTBEAT_STALE_MS;
      else process.env.SCOPE_RUN_HEARTBEAT_STALE_MS = prev;
    }
  });

  it("still deletes message when atomic claim does not match (concurrent retry won)", async () => {
    const h = makeHarness("processing", {
      startedAt: new Date(Date.now() - 15 * 60 * 1000),
      worker: { instanceId: "worker-D" },
    });
    await h.heartbeatStore.set(h.runId, new Date(Date.now() - 10 * 60 * 1000));
    h.findOneAndUpdate.mockResolvedValueOnce(null);

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    expect(h.safeDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
    const finalCalls = h.log.mock.calls.filter((c: any[]) => c[2]?.final);
    expect(finalCalls).toHaveLength(0);
  });

  it("does NOT mark failed when run.status is 'queued' (proceeds to processMultiTurn)", async () => {
    const h = makeHarness("queued");

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    expect(h.findOneAndUpdate).not.toHaveBeenCalled();
    expect(h.safeDeleteMessage).not.toHaveBeenCalled();
    expect((h.qp as any).processMultiTurn).toHaveBeenCalledTimes(1);
  });
});

// ─── Post-processor event-driven dispatch ────────────────────────────────────
describe("CodingAgentQueueProcessor.enqueuePostProcessing", () => {
  it("sends a post-processor queue message when postProcessorQueueName is configured", async () => {
    const configWithPP: QueueProcessorConfig = {
      ...testConfig,
      postProcessorQueueName: "post-processor-queue",
    };
    const qp = new CodingAgentQueueProcessor(configWithPP, stubProcessor);

    const sendMessage = vi.fn().mockResolvedValue({});
    (qp as any).postProcessorQueueClient = { sendMessage };

    await (qp as any).enqueuePostProcessing("req-123", "run-456");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const decoded = JSON.parse(
      Buffer.from(sendMessage.mock.calls[0][0], "base64").toString(),
    );
    expect(decoded).toEqual({ type: "atif", requestId: "req-123", runId: "run-456" });
  });

  it("does nothing when postProcessorQueueClient is null", async () => {
    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    expect((qp as any).postProcessorQueueClient).toBeNull();
    await (qp as any).enqueuePostProcessing("req-123", "run-456");
  });

  it("logs a warning but does not throw on queue send failure", async () => {
    const configWithPP: QueueProcessorConfig = {
      ...testConfig,
      postProcessorQueueName: "post-processor-queue",
    };
    const qp = new CodingAgentQueueProcessor(configWithPP, stubProcessor);

    const sendMessage = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    (qp as any).postProcessorQueueClient = { sendMessage };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await (qp as any).enqueuePostProcessing("req-123", "run-456");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue post-processing"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("enqueues post-processing on stale-heartbeat redelivery when run is marked failed", async () => {
    const configWithPP: QueueProcessorConfig = {
      ...testConfig,
      postProcessorQueueName: "post-processor-queue",
    };
    const qp = new CodingAgentQueueProcessor(configWithPP, stubProcessor);

    const requestId = "req-stale";
    const runId = "run-stale";
    const requestDoc = {
      _id: requestId,
      workerType: "coder-acp-copilot",
      scenario: { criteria: [], task: "x" },
      run: {
        _id: runId,
        status: "processing",
        attemptNumber: 1,
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    } as any;

    const findOneAndUpdate = vi.fn().mockResolvedValue(requestDoc);
    (qp as any).collection = { findOneAndUpdate };
    (qp as any).safeDeleteMessage = vi.fn().mockResolvedValue(undefined);
    (qp as any).heartbeatStore = new InMemoryHeartbeatStore();
    (qp as any).processMultiTurn = vi.fn().mockResolvedValue(undefined);

    const sendMessage = vi.fn().mockResolvedValue({});
    (qp as any).postProcessorQueueClient = { sendMessage };

    const heartbeat: VisibilityHeartbeat = {
      stop: () => "pop-1",
      get popReceipt() { return "pop-1"; },
    };
    const message = { messageId: "msg-1", popReceipt: "pop-1", messageText: "" } as any;
    const log = vi.fn().mockResolvedValue(undefined);

    await (qp as any).handleRequest(requestDoc, message, heartbeat, log, { runId });

    // Should have set postProcessorStatus in the atomic claim
    const [, update] = findOneAndUpdate.mock.calls[0];
    expect(update.$set["run.postProcessorStatus"]).toBe("queued");

    // Should have enqueued the message
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const decoded = JSON.parse(
      Buffer.from(sendMessage.mock.calls[0][0], "base64").toString(),
    );
    expect(decoded).toEqual({ type: "atif", requestId, runId });
  });
});
