// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { RunStateSchema, RunHistoryDocumentSchema } from "./request.js";

describe("RunStateSchema", () => {
  it("accepts a minimal pending attempt", () => {
    const parsed = RunStateSchema.parse({
      _id: "run-1",
      attemptNumber: 1,
      status: "pending",
    });
    expect(parsed._id).toBe("run-1");
    expect(parsed.attemptNumber).toBe(1);
    expect(parsed.status).toBe("pending");
  });

  it("accepts a fully populated done attempt", () => {
    const parsed = RunStateSchema.parse({
      _id: "run-2",
      attemptNumber: 2,
      status: "done",
      outcome: "succeeded",
      result: "ok",
      updatedAt: new Date("2026-04-20T00:00:00Z"),
      startedAt: new Date("2026-04-20T00:00:01Z"),
      finishedAt: new Date("2026-04-20T00:01:00Z"),
      turns: [],
      workerVersion: "copilot-0.0.415-20260420T000000Z-abcd",
      harUrl: "https://example.com/run-2.har",
      videoUrls: ["https://example.com/run-2.webm"],
      tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      aiCallCount: 4,
    });
    expect(parsed.outcome).toBe("succeeded");
    expect(parsed.attemptNumber).toBe(2);
  });

  it("rejects attemptNumber < 1", () => {
    expect(() =>
      RunStateSchema.parse({
        _id: "run-3",
        attemptNumber: 0,
        status: "pending",
      })
    ).toThrow();
  });

  it("rejects unknown status", () => {
    expect(() =>
      RunStateSchema.parse({
        _id: "run-4",
        attemptNumber: 1,
        status: "iterating",
      })
    ).toThrow();
  });
});

describe("RunHistoryDocumentSchema", () => {
  it("requires requestId", () => {
    expect(() =>
      RunHistoryDocumentSchema.parse({
        _id: "run-5",
        attemptNumber: 1,
        status: "done",
        outcome: "failed",
      })
    ).toThrow();
  });

  it("accepts a complete history doc", () => {
    const parsed = RunHistoryDocumentSchema.parse({
      _id: "run-6",
      requestId: "req-1",
      attemptNumber: 1,
      status: "done",
      outcome: "failed",
      error: "boom",
    });
    expect(parsed.requestId).toBe("req-1");
    expect(parsed._id).toBe("run-6");
  });
});
