// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkerResult } from "../types/types.js";

// Mock the HAR sanitizer/extractor so iterations don't try to parse real HARs.
vi.mock("../har/har-parser.js", () => ({
  sanitizeHarFile: vi.fn().mockResolvedValue({
    log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] },
  }),
  extractToolCalls: vi.fn().mockReturnValue([]),
}));

const { runGatedLoop } = await import("./gated-loop.js");

function makeBlob() {
  return {
    uploadFile: vi.fn().mockResolvedValue("https://blob/file"),
    uploadWorkspaceSnapshot: vi.fn().mockResolvedValue({ url: "https://blob/snapshot", sizeBytes: 2048 }),
    writeToolCalls: vi.fn().mockResolvedValue(undefined),
    getToolCallsBlobUrl: vi.fn().mockReturnValue("https://blob/toolcalls"),
  } as any;
}

const baseConfig = () => ({
  workspacePath: "/workspace",
  blobStorage: makeBlob(),
  requestId: "req1",
  runId: "run1",
  log: vi.fn().mockResolvedValue(undefined),
});

describe("runGatedLoop", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs a single Select gate and passes (legacy behaviour)", async () => {
    const processor = {
      workerName: "w",
      processMessage: vi.fn().mockResolvedValue({ response: "done" } satisfies WorkerResult),
    };
    const judgeClient = { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "ok" }) };

    const result = await runGatedLoop({
      ...baseConfig(),
      processor: processor as any,
      judgeClient: judgeClient as any,
      gates: [{ gate: "select", promptText: "do it", criteria: ["c1"], maxIterations: 3 }],
    });

    expect(result.passed).toBe(true);
    expect(result.gateSummaries).toEqual([{ gate: "select", status: "passed", iterations: 1 }]);
    expect(result.turns[0].gate).toBe("select");
  });

  it("runs gates sequentially and passes the whole pipeline", async () => {
    const processor = {
      workerName: "w",
      processMessage: vi.fn().mockResolvedValue({ response: "done" } satisfies WorkerResult),
    };
    const judgeClient = { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "ok" }) };

    const result = await runGatedLoop({
      ...baseConfig(),
      processor: processor as any,
      judgeClient: judgeClient as any,
      gates: [
        { gate: "select", promptText: "build feature", criteria: ["c1"], maxIterations: 2 },
        { gate: "build", promptText: "make it build", criteria: ["c2"], maxIterations: 2 },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.gateSummaries.map((g) => g.status)).toEqual(["passed", "passed"]);
    // gate is passed through to the judge for non-select gates
    const gates = judgeClient.evaluate.mock.calls.map((c: any[]) => c[0].gate);
    expect(gates).toContain("build");
    // iterations are globally unique across gates
    expect(result.turns.map((t) => t.iteration)).toEqual([1, 2]);
    expect(result.turns.map((t) => t.gate)).toEqual(["select", "build"]);
  });

  it("stops the pipeline on the first failing gate and skips downstream gates", async () => {
    const processor = {
      workerName: "w",
      processMessage: vi.fn().mockResolvedValue({ response: "done" } satisfies WorkerResult),
    };
    // select passes, build fails every iteration
    const judgeClient = {
      evaluate: vi.fn().mockImplementation(async (req: any) =>
        req.gate === "build"
          ? { passed: false, feedback: "won't build" }
          : { passed: true, feedback: "ok" },
      ),
    };

    const result = await runGatedLoop({
      ...baseConfig(),
      processor: processor as any,
      judgeClient: judgeClient as any,
      gates: [
        { gate: "select", promptText: "p", criteria: ["c1"], maxIterations: 1 },
        { gate: "build", promptText: "p", criteria: ["c2"], maxIterations: 1 },
        { gate: "test", promptText: "p", criteria: ["c3"], maxIterations: 1 },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.gateSummaries).toEqual([
      { gate: "select", status: "passed", iterations: 1 },
      { gate: "build", status: "failed", iterations: 1 },
      { gate: "test", status: "skipped", iterations: 0 },
    ]);
    // test gate never invoked the agent
    expect(processor.processMessage).toHaveBeenCalledTimes(2);
    expect(result.finalResult).toContain("build");
  });

  it("treats a pass-through gate (no criteria, maxIterations 1) as auto-pass", async () => {
    const processor = {
      workerName: "w",
      processMessage: vi.fn().mockResolvedValue({ response: "done" } satisfies WorkerResult),
    };
    const judgeClient = { evaluate: vi.fn() };

    const result = await runGatedLoop({
      ...baseConfig(),
      processor: processor as any,
      judgeClient: judgeClient as any,
      gates: [{ gate: "select", promptText: "p", criteria: [], maxIterations: 1 }],
    });

    expect(result.passed).toBe(true);
    expect(judgeClient.evaluate).not.toHaveBeenCalled();
    expect(result.gateSummaries).toEqual([{ gate: "select", status: "passed", iterations: 1 }]);
  });

  it("sorts gates into GATE_ORDER before running", async () => {
    const processor = {
      workerName: "w",
      processMessage: vi.fn().mockResolvedValue({ response: "done" } satisfies WorkerResult),
    };
    const judgeClient = { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "ok" }) };

    const result = await runGatedLoop({
      ...baseConfig(),
      processor: processor as any,
      judgeClient: judgeClient as any,
      // intentionally out of order
      gates: [
        { gate: "build", promptText: "p", criteria: ["c2"], maxIterations: 1 },
        { gate: "select", promptText: "p", criteria: ["c1"], maxIterations: 1 },
      ],
    });

    expect(result.gateSummaries.map((g) => g.gate)).toEqual(["select", "build"]);
  });

  it("marks the pipeline as errored when a gate hits an unrecoverable error", async () => {
    const processor = {
      workerName: "w",
      processMessage: vi.fn().mockRejectedValue(new Error("agent crashed")),
    };
    const judgeClient = { evaluate: vi.fn() };

    const result = await runGatedLoop({
      ...baseConfig(),
      processor: processor as any,
      judgeClient: judgeClient as any,
      gates: [
        { gate: "select", promptText: "p", criteria: ["c1"], maxIterations: 2 },
        { gate: "build", promptText: "p", criteria: ["c2"], maxIterations: 1 },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.hadError).toBe(true);
    expect(result.gateSummaries[0].status).toBe("failed");
    expect(result.gateSummaries[1].status).toBe("skipped");
  });
});
