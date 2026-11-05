// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AtifHandler } from "./atif-handler.js";
import type { HandlerContext, PostProcessorMessage } from "../types.js";

// Mock the atifact import
vi.mock("atifact/dist/src/parsers/har.js", () => ({
  parseHar: vi.fn().mockResolvedValue({
    trajectory: {
      schema_version: "ATIF-v1.7",
      session_id: "test-session",
      agent: { name: "test-agent" },
      steps: [],
      final_metrics: {},
    },
  }),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn().mockResolvedValue("/tmp/atif-test"),
}));

describe("AtifHandler", () => {
  let handler: AtifHandler;
  let ctx: HandlerContext;

  beforeEach(() => {
    handler = new AtifHandler();
    ctx = {
      blobStorage: {
        downloadBlobToBuffer: vi.fn().mockResolvedValue(Buffer.from("{}")),
        uploadJson: vi.fn().mockResolvedValue("https://storage.blob.core.windows.net/snapshots/req-1/runs/run-1/iteration-1/atif.trajectory.json"),
      } as any,
      collection: {
        findOne: vi.fn().mockResolvedValue({
          _id: "req-1",
          run: {
            _id: "run-1",
            turns: [
              { iteration: 1, harUrl: "https://storage.blob.core.windows.net/snapshots/req-1/runs/run-1/iteration-1/capture.har" },
              { iteration: 2, harUrl: "https://storage.blob.core.windows.net/snapshots/req-1/runs/run-1/iteration-2/capture.har" },
            ],
          },
        }),
        updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      } as any,
      criteriaCollection: {} as any,
      log: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("has type 'atif'", () => {
    expect(handler.type).toBe("atif");
  });

  it("processes all iterations when no specific iteration is set", async () => {
    const message: PostProcessorMessage = {
      type: "atif",
      requestId: "req-1",
      runId: "run-1",
    };

    await handler.process(message, ctx);

    expect(ctx.blobStorage.downloadBlobToBuffer).toHaveBeenCalledTimes(2);
    expect(ctx.blobStorage.uploadJson).toHaveBeenCalledTimes(2);
    expect(ctx.blobStorage.uploadJson).toHaveBeenCalledWith(
      "req-1/runs/run-1/iteration-1/atif.trajectory.json",
      expect.objectContaining({ schema_version: "ATIF-v1.7" }),
    );
    expect(ctx.collection.updateOne).toHaveBeenCalledTimes(2);
  });

  it("processes only specified iteration when set", async () => {
    const message: PostProcessorMessage = {
      type: "atif",
      requestId: "req-1",
      runId: "run-1",
      iteration: 1,
    };

    await handler.process(message, ctx);

    expect(ctx.blobStorage.downloadBlobToBuffer).toHaveBeenCalledTimes(1);
    expect(ctx.blobStorage.uploadJson).toHaveBeenCalledTimes(1);
  });

  it("skips turns without harUrl", async () => {
    (ctx.collection.findOne as any).mockResolvedValue({
      _id: "req-1",
      run: {
        _id: "run-1",
        turns: [
          { iteration: 1 }, // no harUrl
          { iteration: 2, harUrl: "https://storage.blob.core.windows.net/snapshots/req-1/runs/run-1/iteration-2/capture.har" },
        ],
      },
    });

    const message: PostProcessorMessage = {
      type: "atif",
      requestId: "req-1",
      runId: "run-1",
    };

    await handler.process(message, ctx);

    expect(ctx.blobStorage.downloadBlobToBuffer).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith("info", expect.stringContaining("no HAR available"));
  });

  it("handles 'No LLM API calls found' gracefully", async () => {
    const { parseHar } = await import("atifact/dist/src/parsers/har.js");
    (parseHar as any).mockRejectedValueOnce(new Error("No LLM API calls found in HAR file"));

    const message: PostProcessorMessage = {
      type: "atif",
      requestId: "req-1",
      runId: "run-1",
      iteration: 1,
    };

    // Should not throw
    await handler.process(message, ctx);

    expect(ctx.log).toHaveBeenCalledWith("info", expect.stringContaining("no LLM calls in HAR"));
    expect(ctx.blobStorage.uploadJson).not.toHaveBeenCalled();
  });

  it("skips when no turns exist", async () => {
    (ctx.collection.findOne as any).mockResolvedValue({
      _id: "req-1",
      run: { _id: "run-1", turns: [] },
    });

    const message: PostProcessorMessage = {
      type: "atif",
      requestId: "req-1",
      runId: "run-1",
    };

    await handler.process(message, ctx);

    expect(ctx.blobStorage.downloadBlobToBuffer).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith("info", "No turns found, skipping ATIF generation");
  });
});
