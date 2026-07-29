// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { app, _injectTestDependencies } from "../../index.js";
import { createAllMockDependencies } from "../../test-helpers.js";
import type { LogEvent } from "@scope/core";

// ─── Module stubs (required before app import resolves) ────────────────────

vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({
    ready: true,
    applied: ["001", "002"],
    pending: [],
  }),
}));

vi.mock("./llm.js", () => ({ isLlmAvailable: vi.fn().mockReturnValue(false) }));
vi.mock("./prompt-feature-llm.js", () => ({ isLlmAvailable: vi.fn().mockReturnValue(false) }));
vi.mock("./task-prompt-llm.js", () => ({ isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false) }));

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a raw SSE text body into an array of {event?, data?} objects.
 * Each double-newline delimited block maps to one event.
 */
function parseSse(text: string): Array<{ event?: string; data?: string }> {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const result: { event?: string; data?: string } = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) result.event = line.slice(7);
        if (line.startsWith("data: ")) result.data = line.slice(6);
      }
      return result;
    });
}

function makeLogEvent(msg: string): LogEvent {
  return { timestamp: "2026-01-01T00:00:00Z", level: "info", message: msg };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("SSE log endpoints — blob replay", () => {
  let mocks: ReturnType<typeof createAllMockDependencies>;

  beforeAll(() => {
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
  });

  // =========================================================================
  // GET /api/v1/requests/:id/logs
  // =========================================================================

  describe("GET /api/v1/requests/:id/logs", () => {
    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await request(app).get("/api/v1/requests/missing/logs");
      expect(res.status).toBe(404);
    });

    it("replays blob logs and sends event:done for a completed run (fromStart=true)", async () => {
      const logs = [makeLogEvent("step 1"), makeLogEvent("step 2")];
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "run-done",
        run: { _id: "attempt-1", attemptNumber: 1, status: "done", outcome: "succeeded" },
      });
      (mocks.blobStorage.getLogEvents as any).mockResolvedValue(logs);

      const res = await request(app)
        .get("/api/v1/requests/run-done/logs?fromStart=true")
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => cb(null, data));
        });

      expect(res.headers["content-type"]).toMatch("text/event-stream");
      expect(mocks.blobStorage.getLogEvents).toHaveBeenCalledWith("run-done", "attempt-1");

      const events = parseSse(res.body as string);

      // First two events are the replayed log lines
      expect(events[0].data).toContain("step 1");
      expect(events[1].data).toContain("step 2");

      // Last event is the done signal
      const doneEvent = events.find((e) => e.event === "done");
      expect(doneEvent).toBeDefined();
      expect(JSON.parse(doneEvent!.data!)).toMatchObject({ status: "done", outcome: "succeeded" });
    });

    it("skips blob replay when fromStart is not set", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "run-done",
        run: { _id: "attempt-1", attemptNumber: 1, status: "done", outcome: "succeeded" },
      });

      await request(app)
        .get("/api/v1/requests/run-done/logs")
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => cb(null, data));
        });

      expect(mocks.blobStorage.getLogEvents).not.toHaveBeenCalled();
    });

    it("sends event:error and closes stream when getLogEvents throws", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "run-done",
        run: { _id: "attempt-1", attemptNumber: 1, status: "done", outcome: "succeeded" },
      });
      (mocks.blobStorage.getLogEvents as any).mockRejectedValue(
        Object.assign(new Error("BlobServiceError"), { statusCode: 503 }),
      );

      const res = await request(app)
        .get("/api/v1/requests/run-done/logs?fromStart=true")
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => cb(null, data));
        });

      expect(res.headers["content-type"]).toMatch("text/event-stream");
      const events = parseSse(res.body as string);
      const errorEvent = events.find((e) => e.event === "error");
      expect(errorEvent).toBeDefined();
      expect(JSON.parse(errorEvent!.data!)).toMatchObject({ message: "Cannot connect to log storage" });
    });

    it("sends event:done immediately (no blob data) for a done run with no logs", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "run-empty",
        run: { _id: "attempt-1", attemptNumber: 1, status: "done", outcome: "failed" },
      });
      (mocks.blobStorage.getLogEvents as any).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/v1/requests/run-empty/logs?fromStart=true")
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => cb(null, data));
        });

      const events = parseSse(res.body as string);
      const doneEvent = events.find((e) => e.event === "done");
      expect(doneEvent).toBeDefined();
      expect(JSON.parse(doneEvent!.data!)).toMatchObject({ status: "done", outcome: "failed" });
    });

    it("includes turns_summary event for a done multi-turn run", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "run-mt",
        run: { _id: "attempt-1", attemptNumber: 1, status: "done", outcome: "succeeded", turns: [{ role: "user" }, { role: "assistant" }] },
      });
      (mocks.blobStorage.getLogEvents as any).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/v1/requests/run-mt/logs?fromStart=true")
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => cb(null, data));
        });

      const events = parseSse(res.body as string);
      const summary = events.find(
        (e) => e.data && JSON.parse(e.data).type === "turns_summary",
      );
      expect(summary).toBeDefined();
      expect(JSON.parse(summary!.data!)).toMatchObject({ type: "turns_summary", turns: 2 });
    });
  });

  // =========================================================================
  // GET /api/v1/reports/:id/logs
  // =========================================================================

  describe("GET /api/v1/reports/:id/logs", () => {
    it("returns 404 when report not found", async () => {
      (mocks.reportCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app).get("/api/v1/reports/missing/logs");
      expect(res.status).toBe(404);
    });

    it("replays blob logs and sends event:done for a completed report (fromStart=true)", async () => {
      const logs = [makeLogEvent("report log 1"), makeLogEvent("report log 2")];
      (mocks.reportCollection.findOne as any).mockResolvedValue({
        _id: "report-done",
        status: "completed",
      });
      (mocks.blobStorage.getLogEvents as any).mockResolvedValue(logs);

      const res = await request(app)
        .get("/api/v1/reports/report-done/logs?fromStart=true")
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => cb(null, data));
        });

      expect(res.headers["content-type"]).toMatch("text/event-stream");
      expect(mocks.blobStorage.getLogEvents).toHaveBeenCalledWith("report-done");

      const events = parseSse(res.body as string);
      expect(events[0].data).toContain("report log 1");
      expect(events[1].data).toContain("report log 2");

      const doneEvent = events.find((e) => e.event === "done");
      expect(doneEvent).toBeDefined();
      expect(JSON.parse(doneEvent!.data!)).toMatchObject({ status: "completed" });
    });

    it("replays blob logs and sends event:done for a failed report", async () => {
      (mocks.reportCollection.findOne as any).mockResolvedValue({
        _id: "report-failed",
        status: "failed",
      });
      (mocks.blobStorage.getLogEvents as any).mockResolvedValue([makeLogEvent("error")]);

      const res = await request(app)
        .get("/api/v1/reports/report-failed/logs?fromStart=true")
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => cb(null, data));
        });

      const events = parseSse(res.body as string);
      const doneEvent = events.find((e) => e.event === "done");
      expect(doneEvent).toBeDefined();
      expect(JSON.parse(doneEvent!.data!)).toMatchObject({ status: "failed" });
    });

    it("skips blob replay for reports when fromStart is not set", async () => {
      (mocks.reportCollection.findOne as any).mockResolvedValue({
        _id: "report-done",
        status: "completed",
      });

      await request(app)
        .get("/api/v1/reports/report-done/logs")
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => cb(null, data));
        });

      expect(mocks.blobStorage.getLogEvents).not.toHaveBeenCalled();
    });

    it("sends event:error and closes stream when getLogEvents throws for a report", async () => {
      (mocks.reportCollection.findOne as any).mockResolvedValue({
        _id: "report-done",
        status: "completed",
      });
      (mocks.blobStorage.getLogEvents as any).mockRejectedValue(
        Object.assign(new Error("BlobServiceError"), { statusCode: 503 }),
      );

      const res = await request(app)
        .get("/api/v1/reports/report-done/logs?fromStart=true")
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => cb(null, data));
        });

      expect(res.headers["content-type"]).toMatch("text/event-stream");
      const events = parseSse(res.body as string);
      const errorEvent = events.find((e) => e.event === "error");
      expect(errorEvent).toBeDefined();
      expect(JSON.parse(errorEvent!.data!)).toMatchObject({ message: "Cannot connect to log storage" });
    });
  });
});
