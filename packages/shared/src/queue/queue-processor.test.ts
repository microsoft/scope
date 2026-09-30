// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import { CodingAgentQueueProcessor, pairBindingsWithConfigs } from "./queue-processor.js";
import type { QueueProcessorConfig, WorkerProcessor, WorkerResult } from "../types/types.js";
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it("uses SCOPE_AGENT_VERSION when the processor does not expose a version", () => {
    vi.stubEnv("SCOPE_AGENT_VERSION", "registered-v2");
    const noVersionProcessor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "ok" };
      },
    };
    const qp = new CodingAgentQueueProcessor(testConfig, noVersionProcessor);
    const fields = (qp as any).getVersionFields();

    expect(fields.workerVersion).toMatch(/^registered-v2-/);
    expect(fields.os).toBeDefined();
  });

  it("fails at startup when no registry runtime identity is available", () => {
    vi.stubEnv("SCOPE_AGENT_VERSION", "");
    const noVersionProcessor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "ok" };
      },
    };
    expect(
      () => new CodingAgentQueueProcessor(testConfig, noVersionProcessor),
    ).toThrow(/SCOPE_AGENT_VERSION or getAgentVersion/);
  });
});

// ─── AGENTS.md workspace delivery ────────────────────────────────────────────
describe("CodingAgentQueueProcessor.writeAgentsMd", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops when the request has no agentsMdPromptId", async () => {
    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    const log = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await (qp as any).writeAgentsMd({ _id: "r1" }, "/tmp/does-not-matter", log);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when agentsMdPromptId is set but apiBaseUrl is missing", async () => {
    // testConfig has no apiBaseUrl.
    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    const log = vi.fn().mockResolvedValue(undefined);

    await expect(
      (qp as any).writeAgentsMd({ _id: "r1", agentsMdPromptId: "agents-1" }, "/tmp", log),
    ).rejects.toThrow(/apiBaseUrl/);
  });

  it("writes the resolved AGENTS.md body into the workspace root", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "agents-md-test-"));

    try {
      const qp = new CodingAgentQueueProcessor(
        { ...testConfig, apiBaseUrl: "https://api.example.com" },
        stubProcessor,
      );
      const log = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ id: "agents-1", text: "# AGENTS\nBe terse." }),
        }),
      );

      await (qp as any).writeAgentsMd({ _id: "r1", agentsMdPromptId: "agents-1" }, workspace, log);

      const written = await readFile(join(workspace, "AGENTS.md"), "utf-8");
      expect(written).toBe("# AGENTS\nBe terse.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

// ─── Redelivery fail-fast (handleRequest pre-checks) ─────────────────────────
describe("CodingAgentQueueProcessor.handleRequest redelivery handling", () => {
  function makeHarness(runStatus: string, runOverrides: Record<string, unknown> = {}) {
    const requestId = "req-1";
    const runId = "run-1";
    const requestDoc = {
      _id: requestId,
      projectId: "proj-1",
      workerType: "test-worker",
      agentVersion: "test-1.0.0",
      scenario: { criteria: [], task: "x" },
      run: { _id: runId, status: runStatus, attemptNumber: 1, ...runOverrides },
    } as any;

    const findOneAndUpdate = vi.fn().mockResolvedValue(requestDoc);
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const collection = { findOneAndUpdate, updateOne } as any;

    const safeDeleteMessage = vi.fn().mockResolvedValue(undefined);
    const safeDeferMessage = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn().mockResolvedValue(undefined);

    const stop = vi.fn().mockReturnValue("frozen-pop-1");
    const heartbeat: VisibilityHeartbeat = {
      stop,
      get popReceipt() { return "pop-1"; },
    };
    const message = { messageId: "msg-1", popReceipt: "pop-1", messageText: "" } as any;

    const heartbeatStore = new InMemoryHeartbeatStore();

    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    (qp as any).collection = collection;
    (qp as any).safeDeleteMessage = safeDeleteMessage;
    (qp as any).safeDeferMessage = safeDeferMessage;
    (qp as any).heartbeatStore = heartbeatStore;
    // Guard: if the redelivery branch ever falls through, processMultiTurn
    // would be invoked. Stub it so any accidental call is observable.
    (qp as any).processMultiTurn = vi.fn().mockResolvedValue(undefined);

    return { qp, requestDoc, message, heartbeat, stop, log, findOneAndUpdate, updateOne, safeDeleteMessage, safeDeferMessage, heartbeatStore, runId, requestId };
  }

  it("defers a legacy misrouted message for another worker", async () => {
    const h = makeHarness("queued");
    h.requestDoc.workerType = "other-worker";

    await (h.qp as any).handleRequest(
      h.requestDoc,
      h.message,
      h.heartbeat,
      h.log,
      { runId: h.runId },
    );

    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.safeDeferMessage).toHaveBeenCalledWith(
      "msg-1",
      "frozen-pop-1",
      0,
    );
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
  });

  it("defers a legacy misrouted message for another agent version", async () => {
    const h = makeHarness("queued");
    h.requestDoc.agentVersion = "test-2.0.0";

    await (h.qp as any).handleRequest(
      h.requestDoc,
      h.message,
      h.heartbeat,
      h.log,
      { runId: h.runId },
    );

    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.safeDeferMessage).toHaveBeenCalledWith(
      "msg-1",
      "frozen-pop-1",
      0,
    );
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
  });

  it("deletes a stale message after the scheduler returns its run to pending", async () => {
    const h = makeHarness("pending");
    h.requestDoc.workerType = "other-worker";

    await (h.qp as any).handleRequest(
      h.requestDoc,
      h.message,
      h.heartbeat,
      h.log,
      { runId: h.runId },
    );

    expect(h.safeDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
    expect(h.safeDeferMessage).not.toHaveBeenCalled();
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
  });

  it("deletes a stale message after the target moves to another queue", async () => {
    const h = makeHarness("queued", { queuedQueueName: "new-queue" });

    await (h.qp as any).handleRequest(
      h.requestDoc,
      h.message,
      h.heartbeat,
      h.log,
      { runId: h.runId },
    );

    expect(h.safeDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
    expect(h.updateOne).not.toHaveBeenCalled();
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
  });

  it("binds the atomic processing claim to the worker queue", async () => {
    const h = makeHarness("queued", { queuedQueueName: "test-queue" });

    await (h.qp as any).handleRequest(
      h.requestDoc,
      h.message,
      h.heartbeat,
      h.log,
      { runId: h.runId },
    );

    expect(h.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: h.requestId,
        "run._id": h.runId,
        "run.status": "queued",
        "run.queuedQueueName": "test-queue",
      }),
      expect.any(Object),
    );
  });

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

  it("RE-DEFERS duplicate (does not fail or delete) when no heartbeat but startedAt is recent", async () => {
    // No Redis heartbeat yet AND run was just picked up — this is a
    // transient race (queue redelivered before the first beat fired, or a
    // brief Redis blip). Must NOT fail healthy runs, and must NOT delete the
    // message (that would destroy the only recovery trigger if the worker
    // later dies hard). Re-defer instead.
    const h = makeHarness("processing", {
      startedAt: new Date(Date.now() - 5_000),
      worker: { instanceId: "worker-X" },
    });

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    expect(h.findOneAndUpdate).not.toHaveBeenCalled();
    // Heartbeat is stopped first to freeze the pop receipt, then the message
    // is re-deferred with that frozen receipt — never deleted.
    expect(h.stop).toHaveBeenCalled();
    expect(h.safeDeferMessage).toHaveBeenCalledWith("msg-1", "frozen-pop-1", 120);
    expect(h.safeDeleteMessage).not.toHaveBeenCalled();
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(/Duplicate queue message re-deferred/),
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

  it("re-defers duplicate message WITHOUT touching run state when heartbeat is fresh", async () => {
    const h = makeHarness("processing", {
      startedAt: new Date(Date.now() - 60_000),
      worker: { instanceId: "worker-B", podName: "pod-B" },
    });
    // 5 seconds ago — well within the 120 s threshold.
    await h.heartbeatStore.set(h.runId, new Date(Date.now() - 5_000));

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    // Critical: no DB write — the original worker keeps its run state.
    expect(h.findOneAndUpdate).not.toHaveBeenCalled();
    // And the message is re-deferred (kept alive), not deleted.
    expect(h.stop).toHaveBeenCalled();
    expect(h.safeDeferMessage).toHaveBeenCalledWith("msg-1", "frozen-pop-1", 120);
    expect(h.safeDeleteMessage).not.toHaveBeenCalled();
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(/Duplicate queue message re-deferred.*worker-B/),
      expect.objectContaining({ runId: h.runId }),
    );
    const finalCalls = h.log.mock.calls.filter((c: any[]) => c[2]?.final);
    expect(finalCalls).toHaveLength(0);
  });

  it("respects SCOPE_RUN_REDELIVER_DEFER_MS override for the re-defer interval", async () => {
    const prev = process.env.SCOPE_RUN_REDELIVER_DEFER_MS;
    process.env.SCOPE_RUN_REDELIVER_DEFER_MS = "30000"; // 30 s
    try {
      const h = makeHarness("processing", {
        startedAt: new Date(Date.now() - 60_000),
        worker: { instanceId: "worker-B" },
      });
      await h.heartbeatStore.set(h.runId, new Date(Date.now() - 5_000));

      await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

      expect(h.safeDeferMessage).toHaveBeenCalledWith("msg-1", "frozen-pop-1", 30);
    } finally {
      if (prev === undefined) delete process.env.SCOPE_RUN_REDELIVER_DEFER_MS;
      else process.env.SCOPE_RUN_REDELIVER_DEFER_MS = prev;
    }
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
    expect(h.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: h.requestId,
        "run._id": h.runId,
        "run.status": "queued",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ "run.status": "processing" }),
      }),
    );
    expect(h.safeDeleteMessage).not.toHaveBeenCalled();
    expect((h.qp as any).processMultiTurn).toHaveBeenCalledTimes(1);
  });
});

describe("CodingAgentQueueProcessor pre-processing failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("claims the exact run before extension resolution and terminalizes a resolver error", async () => {
    const requestId = "req-extension-failure";
    const runId = "run-extension-failure";
    const requestDoc = {
      _id: requestId,
      projectId: "project with spaces",
      workerType: "test-worker",
      agentVersion: "test-1.0.0",
      extensions: ["ms-python.python"],
      scenario: { criteria: [], task: "x" },
      run: { _id: runId, status: "queued", attemptNumber: 1 },
    } as any;

    const updateOne = vi
      .fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 1 });
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const qp = new CodingAgentQueueProcessor(
      { ...testConfig, apiBaseUrl: "http://api:80" },
      stubProcessor,
    );
    (qp as any).collection = {
      findOne: vi.fn().mockResolvedValue(requestDoc),
      updateOne,
    };
    (qp as any).queueClient = {
      updateMessage: vi.fn().mockResolvedValue({ popReceipt: "next-receipt" }),
      deleteMessage,
    };
    (qp as any).logPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
      evictRun: vi.fn(),
    };
    (qp as any).heartbeatStore = new InMemoryHeartbeatStore();
    (qp as any).processMultiTurn = vi.fn().mockResolvedValue(undefined);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
    });
    vi.stubGlobal("fetch", fetchMock);

    const message = {
      messageId: "message-1",
      popReceipt: "receipt-1",
      messageText: Buffer.from(JSON.stringify({ requestId, runId })).toString("base64"),
    } as any;

    await (qp as any).processMessage(message);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api:80/api/v1/extensions/ms-python.python?projectId=project%20with%20spaces",
    );
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls[0][0]).toEqual({
      _id: requestId,
      "run._id": runId,
      "run.status": "queued",
      "run.queuedQueueName": "test-queue",
    });
    expect(updateOne.mock.calls[1][0]).toEqual({
      _id: requestId,
      "run._id": runId,
      "run.status": "processing",
      "run.worker.instanceId": (qp as any).instanceId,
    });
    expect(updateOne.mock.calls[1][1].$set).toMatchObject({
      "run.status": "done",
      "run.outcome": "failed",
      "run.error": expect.stringMatching(/400 Bad Request/),
      "run.durationMs": expect.any(Number),
    });
    expect((qp as any).processMultiTurn).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith("message-1", "receipt-1");
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
      workerType: "test-worker",
      agentVersion: "test-1.0.0",
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

describe("pairBindingsWithConfigs", () => {
  const config = (slug: string, revisionId: string) => ({
    ref: `${slug}@r1`,
    resourceId: `res-${slug}`,
    revisionId,
    slug,
    name: slug,
    setup: { sh: "echo setup" },
    exports: [],
  });

  it("attaches each binding's parameters to its config", () => {
    const paired = pairBindingsWithConfigs(
      [{ ref: "sim@r1", revisionId: "rev-1", params: { REPO: "alpha" } }],
      [config("sim", "rev-1")],
    );
    expect(paired).toHaveLength(1);
    expect(paired[0].params).toEqual({ REPO: "alpha" });
  });

  it("keeps duplicate bindings of one revision independent", () => {
    // Regression: matching configs to bindings with find() by revisionId gave both
    // occurrences the first binding's parameters, so two simulators intended for
    // different repos both silently targeted the first one.
    const paired = pairBindingsWithConfigs(
      [
        { ref: "sim@r1", revisionId: "rev-1", params: { REPO: "alpha" } },
        { ref: "sim@r1", revisionId: "rev-1", params: { REPO: "beta" } },
      ],
      [config("sim", "rev-1")],
    );
    expect(paired).toHaveLength(2);
    expect(paired[0].params).toEqual({ REPO: "alpha" });
    expect(paired[1].params).toEqual({ REPO: "beta" });
  });

  it("preserves submission order when the resolver reorders", () => {
    const paired = pairBindingsWithConfigs(
      [
        { ref: "db@r1", revisionId: "rev-db" },
        { ref: "sim@r1", revisionId: "rev-sim" },
      ],
      [config("sim", "rev-sim"), config("db", "rev-db")],
    );
    expect(paired.map((c) => c.slug)).toEqual(["db", "sim"]);
  });

  it("leaves params unset when a binding has none", () => {
    const paired = pairBindingsWithConfigs(
      [{ ref: "sim@r1", revisionId: "rev-1", params: {} }],
      [config("sim", "rev-1")],
    );
    expect(paired[0].params).toBeUndefined();
  });

  it("throws when the resolver omits a binding's revision", () => {
    expect(() =>
      pairBindingsWithConfigs([{ ref: "sim@r1", revisionId: "rev-missing" }], []),
    ).toThrow(/rev-missing/);
  });
});

// ─── Lifecycle teardown boundary ─────────────────────────────────────────────
describe("CodingAgentQueueProcessor lifecycle teardown boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Regression: resource provisioning happens inside setup(), but setup used to
  // sit outside the try/finally that calls teardown(). Any failure between setup
  // and the agent loop — MCP registration, codebase seeding, skill extraction,
  // gate-prompt resolution — left provisioned resources running.
  it("tears down when initialization fails after setup succeeds", async () => {
    const teardown = vi.fn().mockResolvedValue(undefined);
    const setup = vi.fn().mockResolvedValue(undefined);
    const processor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "ok" };
      },
      getAgentVersion: () => "test-1.0.0",
      setup,
      teardown,
      getRunObservations: () => ({ resources: [], mcpRegistered: false }),
    };

    const qp = new CodingAgentQueueProcessor(
      {
        ...testConfig,
        // BlobStorage is constructed before setup runs, so it needs a parseable
        // endpoint for the test to reach the code path under test.
        storageConnectionString:
          "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;",
      },
      processor,
    );
    (qp as any).collection = { updateOne: vi.fn().mockResolvedValue({}) };
    (qp as any).logPublisher = { publish: vi.fn().mockResolvedValue(undefined), evictRun: vi.fn() };
    (qp as any).heartbeatStore = new InMemoryHeartbeatStore();

    // Seeding runs straight after setup and throws without this variable, which
    // makes it a faithful stand-in for any post-setup initialization failure.
    vi.stubEnv("SCOPE_MT_API_URL", "");

    const requestDoc = {
      _id: "req-teardown",
      projectId: "p1",
      workerType: "test-worker",
      scenario: { task: "t", criteria: [] },
      maxIterations: 1,
      codebaseRevisionId: "codebase@r1",
      run: { _id: "run-teardown", status: "processing" },
    } as any;

    await expect(
      (qp as any).processMultiTurn(
        requestDoc,
        { messageId: "m1", popReceipt: "r1" },
        { stop: vi.fn() },
        vi.fn().mockResolvedValue(undefined),
        new Date(),
      ),
    ).rejects.toThrow(/SCOPE_MT_API_URL/);

    expect(setup).toHaveBeenCalled();
    expect(teardown).toHaveBeenCalled();
  });
});
