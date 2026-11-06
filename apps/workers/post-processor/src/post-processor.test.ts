// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { PostProcessor, type PostProcessorConfig } from "./post-processor.js";

const config: PostProcessorConfig = {
  mongoUri: "mongodb://localhost:27017",
  mongoDatabase: "test-db",
  mongoCollection: "requests",
  storageAccountName: "devstoreaccount1",
  storageConnectionString: "UseDevelopmentStorage=true",
  queueName: "post-processor",
  batchSize: 1,
  pollIntervalMs: 1000,
  redisHost: "localhost",
  redisPort: 6379,
  redisPassword: "",
};

describe("PostProcessor attempt isolation", () => {
  async function processWithResults(...results: number[]) {
    const worker = new PostProcessor(config);
    const updateOne = vi.fn();
    for (const matchedCount of results) updateOne.mockResolvedValueOnce({ matchedCount });
    (worker as any).collection = { updateOne };

    const process = vi.fn().mockResolvedValue(undefined);
    worker.registerHandler({ type: "atif", process });
    const safeDeleteMessage = vi.fn().mockResolvedValue(undefined);
    const triggerReportGeneration = vi.fn().mockResolvedValue(undefined);
    (worker as any).safeDeleteMessage = safeDeleteMessage;
    (worker as any).triggerReportGeneration = triggerReportGeneration;

    const log = vi.fn().mockResolvedValue(undefined);
    const heartbeat = { stop: vi.fn().mockReturnValue("receipt-1") } as any;
    const message = { messageId: "message-1", popReceipt: "receipt-1" } as any;
    const doc = { _id: "request-1", run: { _id: "run-1", status: "done" } };

    await (worker as any).handleRequest(doc, message, heartbeat, log, {
      type: "atif", requestId: "request-1", runId: "run-1",
    });

    return { updateOne, process, safeDeleteMessage, triggerReportGeneration, log };
  }

  it("discards a stale message before running its handler", async () => {
    const result = await processWithResults(0);

    expect(result.updateOne).toHaveBeenCalledWith(
      { _id: "request-1", "run._id": "run-1", "run.status": "done" },
      { $set: { "run.postProcessorStatus": "processing" } },
    );
    expect(result.process).not.toHaveBeenCalled();
    expect(result.safeDeleteMessage).toHaveBeenCalledWith("message-1", "receipt-1");
  });

  it("does not stamp or trigger a report when a retry replaces the run during processing", async () => {
    const result = await processWithResults(1, 0);

    expect(result.process).toHaveBeenCalledTimes(1);
    expect(result.updateOne.mock.calls[1][0]).toEqual({
      _id: "request-1", "run._id": "run-1", "run.status": "done",
    });
    expect(result.triggerReportGeneration).not.toHaveBeenCalled();
    expect(result.safeDeleteMessage).toHaveBeenCalledWith("message-1", "receipt-1");
  });
});
