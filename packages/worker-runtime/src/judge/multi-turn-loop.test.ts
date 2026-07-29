// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkerResult } from "@scope/core";
import { throwIfCopilotError } from "../workers/copilot-error.js";

// Mock @scope/platform (BlobStorage + HAR utilities)
const mockUploadFile = vi.fn();
const mockSanitizeHarFile = vi.fn();
const mockExtractToolCalls = vi.fn().mockReturnValue([]);
vi.mock("@scope/platform", () => ({
  BlobStorage: vi.fn().mockImplementation(() => ({
    uploadFile: mockUploadFile,
    uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot"),
  })),
  sanitizeHarFile: (...args: unknown[]) => mockSanitizeHarFile(...args),
  extractToolCalls: (...args: unknown[]) => mockExtractToolCalls(...args),
}));


// Mock JudgeClient
vi.mock("./judge-client.js", () => ({
  JudgeClient: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "All good" }),
  })),
}));

// Import after mocks
const { runMultiTurnLoop } = await import("./multi-turn-loop.js");

describe("runMultiTurnLoop — video upload", () => {
  const mockProcessor = {
    workerName: "test-worker",
    processMessage: vi.fn(),
  };

  const mockLog = vi.fn().mockResolvedValue(undefined);
  const mockOnTurnComplete = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadFile.mockReset();
    mockSanitizeHarFile.mockReset().mockResolvedValue({ log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] } });
    mockExtractToolCalls.mockReset().mockReturnValue([]);
  });

  it("uploads video files and includes videoUrls in turn when worker returns videoFilePaths", async () => {
    mockProcessor.processMessage.mockResolvedValue({
      response: "done",
      videoFilePaths: ["/tmp/video-0.webm", "/tmp/video-1.webm"],
    } satisfies WorkerResult);

    const mockBlobUploadFile = vi.fn()
      .mockResolvedValueOnce("https://blob/snapshots/req1/runs/attempt-1/iteration-1/video-0.webm")
      .mockResolvedValueOnce("https://blob/snapshots/req1/runs/attempt-1/iteration-1/video-1.webm");

    const result = await runMultiTurnLoop({
      processor: mockProcessor as any,
      task: "Do something",
      criteria: ["check"],
      maxIterations: 1,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: { uploadFile: mockBlobUploadFile, uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot") } as any,
      requestId: "req1",
      runId: "attempt-1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
    });

    expect(result.passed).toBe(true);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].videoUrls).toEqual([
      "https://blob/snapshots/req1/runs/attempt-1/iteration-1/video-0.webm",
      "https://blob/snapshots/req1/runs/attempt-1/iteration-1/video-1.webm",
    ]);
    // Verify upload was called with correct blob names and content type
    expect(mockBlobUploadFile).toHaveBeenCalledWith("/tmp/video-0.webm", "req1/runs/attempt-1/iteration-1/video-0.webm", "video/webm");
    expect(mockBlobUploadFile).toHaveBeenCalledWith("/tmp/video-1.webm", "req1/runs/attempt-1/iteration-1/video-1.webm", "video/webm");
  });

  it("does not include videoUrls when worker returns no videoFilePaths", async () => {
    mockProcessor.processMessage.mockResolvedValue({
      response: "done",
    } satisfies WorkerResult);

    const mockBlobUploadFile = vi.fn();

    const result = await runMultiTurnLoop({
      processor: mockProcessor as any,
      task: "Do something",
      criteria: ["check"],
      maxIterations: 1,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: { uploadFile: mockBlobUploadFile, uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot") } as any,
      requestId: "req1",
      runId: "attempt-1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
    });

    expect(result.turns[0].videoUrls).toBeUndefined();
  });

  it("logs warning but continues when video upload fails", async () => {
    mockProcessor.processMessage.mockResolvedValue({
      response: "done",
      videoFilePaths: ["/tmp/video-0.webm"],
    } satisfies WorkerResult);

    const mockBlobUploadFile = vi.fn().mockRejectedValueOnce(new Error("upload failed"));

    const result = await runMultiTurnLoop({
      processor: mockProcessor as any,
      task: "Do something",
      criteria: ["check"],
      maxIterations: 1,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: { uploadFile: mockBlobUploadFile, uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot") } as any,
      requestId: "req1",
      runId: "attempt-1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
    });

    // Should still complete the turn despite video upload failure
    expect(result.passed).toBe(true);
    expect(mockLog).toHaveBeenCalledWith("warn", expect.stringContaining("Failed to upload video"), expect.anything());
  });
});

describe("runMultiTurnLoop — lifecycle hooks", () => {
  const mockLog = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeHarFile.mockReset().mockResolvedValue({ log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] } });
    mockExtractToolCalls.mockReset().mockReturnValue([]);
  });

  function makeConfig(processor: any, overrides: Record<string, unknown> = {}) {
    return {
      processor,
      task: "Do something",
      criteria: ["check"],
      maxIterations: 3,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: { uploadFile: vi.fn().mockResolvedValue("https://blob/video"), uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot") } as any,
      requestId: "req1",
      runId: "attempt-1",
      log: mockLog,
      ...overrides,
    };
  }

  it("does not call setup or teardown (caller owns lifecycle)", async () => {
    const processor = {
      workerName: "test-worker",
      setup: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      processMessage: vi.fn(async () => ({ response: "done" })),
    };

    await runMultiTurnLoop(makeConfig(processor));

    expect(processor.setup).not.toHaveBeenCalled();
    expect(processor.teardown).not.toHaveBeenCalled();
    expect(processor.processMessage).toHaveBeenCalled();
  });

  it("handles processMessage error without calling teardown", async () => {
    const processor = {
      workerName: "test-worker",
      setup: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      processMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };

    const result = await runMultiTurnLoop(makeConfig(processor));

    // Multi-turn loop catches processMessage errors and returns a failed result
    expect(result.passed).toBe(false);
    expect(processor.teardown).not.toHaveBeenCalled();
  });

  it("works without setup/teardown (backward compatible)", async () => {
    const processor = {
      workerName: "test-worker",
      processMessage: vi.fn(async () => ({ response: "done" })),
    };

    const result = await runMultiTurnLoop(makeConfig(processor));

    expect(result.passed).toBe(true);
    expect(processor.processMessage).toHaveBeenCalled();
  });

  it("runs multiple iterations without managing lifecycle", async () => {
    let iteration = 0;
    const processor = {
      workerName: "test-worker",
      setup: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      processMessage: vi.fn(async () => {
        iteration++;
        return { response: `iteration ${iteration}` };
      }),
    };

    // Judge fails first 2, passes on 3rd
    let judgeCallCount = 0;
    const judgeClient = {
      evaluate: vi.fn(async () => {
        judgeCallCount++;
        return { passed: judgeCallCount >= 3, feedback: judgeCallCount < 3 ? "Try again" : "OK" };
      }),
    };

    const result = await runMultiTurnLoop(makeConfig(processor, { judgeClient }));

    expect(result.passed).toBe(true);
    expect(result.turns).toHaveLength(3);
    expect(processor.setup).not.toHaveBeenCalled();
    expect(processor.teardown).not.toHaveBeenCalled();
    expect(processor.processMessage).toHaveBeenCalledTimes(3);
  });
});

describe("runMultiTurnLoop — tool call extraction", () => {
  const mockLog = vi.fn().mockResolvedValue(undefined);
  const mockOnTurnComplete = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeHarFile.mockReset();
    mockExtractToolCalls.mockReset();
  });

  function makeConfig(overrides: Record<string, unknown> = {}) {
    return {
      processor: {
        workerName: "test-worker",
        processMessage: vi.fn(),
      },
      task: "Do something",
      criteria: ["check"],
      maxIterations: 1,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: {
        uploadFile: vi.fn().mockResolvedValue("https://blob/har"),
        uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot"),
        writeToolCalls: vi.fn().mockResolvedValue(undefined),
        getToolCallsBlobUrl: vi.fn().mockReturnValue("https://blob/tool-calls.jsonl"),
      } as any,
      requestId: "req1",
      runId: "attempt-1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
      ...overrides,
    };
  }

  it("extracts tool calls from HAR and writes them to a JSONL blob, recording url + count on the turn", async () => {
    const harFile = { log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] } };
    mockSanitizeHarFile.mockResolvedValue(harFile);

    const expectedToolCalls = [
      { id: "tc_1", name: "read_file", arguments: { path: "/foo.ts" }, timestamp: "2026-03-25T14:00:00Z" },
      { id: "tc_2", name: "write_file", arguments: { path: "/bar.ts" }, timestamp: "2026-03-25T14:01:00Z" },
    ];
    mockExtractToolCalls.mockReturnValue(expectedToolCalls);

    const config = makeConfig();
    (config.processor as any).processMessage.mockResolvedValue({
      response: "done",
      harFilePath: "/tmp/devproxy.har",
    } satisfies WorkerResult);

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(true);
    expect(result.turns[0].toolCalls).toBeUndefined();
    expect(result.turns[0].toolCallsUrl).toBe("https://blob/tool-calls.jsonl");
    expect(result.turns[0].toolCallCount).toBe(2);
    expect(mockExtractToolCalls).toHaveBeenCalledWith(harFile);
    const writeToolCalls = (config.blobStorage as any).writeToolCalls;
    expect(writeToolCalls).toHaveBeenCalledTimes(1);
    expect(writeToolCalls).toHaveBeenCalledWith("req1", "attempt-1", 1, expectedToolCalls);
  });

  it("does not record toolCallsUrl when no HAR file is available", async () => {
    const config = makeConfig();
    (config.processor as any).processMessage.mockResolvedValue({
      response: "done",
    } satisfies WorkerResult);

    const result = await runMultiTurnLoop(config as any);

    expect(result.turns[0].toolCalls).toBeUndefined();
    expect(result.turns[0].toolCallsUrl).toBeUndefined();
    expect(result.turns[0].toolCallCount).toBeUndefined();
    expect(mockExtractToolCalls).not.toHaveBeenCalled();
    expect((config.blobStorage as any).writeToolCalls).not.toHaveBeenCalled();
  });

  it("does not record toolCallsUrl when extraction returns empty array", async () => {
    mockSanitizeHarFile.mockResolvedValue({ log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] } });
    mockExtractToolCalls.mockReturnValue([]);

    const config = makeConfig();
    (config.processor as any).processMessage.mockResolvedValue({
      response: "done",
      harFilePath: "/tmp/devproxy.har",
    } satisfies WorkerResult);

    const result = await runMultiTurnLoop(config as any);

    expect(result.turns[0].toolCalls).toBeUndefined();
    expect(result.turns[0].toolCallsUrl).toBeUndefined();
    expect(result.turns[0].toolCallCount).toBeUndefined();
    expect((config.blobStorage as any).writeToolCalls).not.toHaveBeenCalled();
  });

  it("logs warning but continues when tool call extraction fails", async () => {
    mockSanitizeHarFile.mockResolvedValue({ log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] } });
    mockExtractToolCalls.mockImplementation(() => { throw new Error("parse error"); });

    const config = makeConfig();
    (config.processor as any).processMessage.mockResolvedValue({
      response: "done",
      harFilePath: "/tmp/devproxy.har",
    } satisfies WorkerResult);

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(true);
    expect(result.turns[0].toolCalls).toBeUndefined();
    expect(result.turns[0].toolCallsUrl).toBeUndefined();
    expect(mockLog).toHaveBeenCalledWith("warn", expect.stringContaining("Failed to extract or persist tool calls"), expect.anything());
  });
});

describe("runMultiTurnLoop — hadError", () => {
  const mockLog = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeHarFile.mockReset().mockResolvedValue({ log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] } });
    mockExtractToolCalls.mockReset().mockReturnValue([]);
  });

  function makeConfig(overrides: Record<string, unknown> = {}) {
    return {
      processor: {
        workerName: "test-worker",
        processMessage: vi.fn(),
      },
      task: "Do something",
      criteria: ["check"],
      maxIterations: 2,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: false, feedback: "Not done" }) } as any,
      blobStorage: {
        uploadFile: vi.fn().mockResolvedValue("https://blob/file"),
        uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot"),
      } as any,
      requestId: "req1",
      runId: "attempt-1",
      log: mockLog,
      ...overrides,
    };
  }

  it("hadError is true when the coding agent throws", async () => {
    const config = makeConfig();
    (config.processor as any).processMessage.mockRejectedValue(new Error("Agent crashed"));

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(false);
    expect(result.hadError).toBe(true);
    expect(result.finalResult).toContain("Coding agent failed");
  });

  it("hadError is false when max iterations are exhausted without any agent error", async () => {
    const config = makeConfig();
    (config.processor as any).processMessage.mockResolvedValue({ response: "partial work" } satisfies WorkerResult);

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(false);
    expect(result.hadError).toBe(false);
    expect(result.finalResult).toContain("Max iterations");
  });

  it("full path: worker calls throwIfCopilotError on errorDetails response → hadError true → finalResult contains error message (issue #554)", async () => {
    // Exact errorDetails payload from issue #554
    const errorPayload = `{"errorDetails":{"code":"length","message":"Sorry, the response hit the length limit. Please rephrase your prompt.","confirmationButtons":[{"data":{"copilotContinueOnError":true},"label":"Try Again"}]}}`;

    const config = makeConfig({ maxIterations: 1 });
    // Simulate what the VS Code worker does: receive the JSON response, call throwIfCopilotError, which throws
    (config.processor as any).processMessage.mockImplementation(async () => {
      throwIfCopilotError(errorPayload);
      return { response: errorPayload } satisfies WorkerResult; // never reached
    });

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(false);
    expect(result.hadError).toBe(true);
    expect(result.finalResult).toContain("Coding agent failed");
    expect(result.finalResult).toContain("Sorry, the response hit the length limit");
  });
});

describe("runMultiTurnLoop — aiCallCount", () => {
  const mockLog = vi.fn().mockResolvedValue(undefined);
  const mockOnTurnComplete = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeHarFile.mockReset().mockResolvedValue({ log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] } });
    mockExtractToolCalls.mockReset().mockReturnValue([]);
  });

  function makeConfig(overrides: Record<string, unknown> = {}) {
    return {
      processor: {
        workerName: "test-worker",
        processMessage: vi.fn(),
      },
      task: "Do something",
      criteria: ["check"],
      maxIterations: 1,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: {
        uploadFile: vi.fn().mockResolvedValue("https://blob/har"),
        uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot"),
      } as any,
      requestId: "req1",
      runId: "attempt-1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
      ...overrides,
    };
  }

  it("includes aiCallCount on the completed turn when worker returns it", async () => {
    const config = makeConfig();
    (config.processor as any).processMessage.mockResolvedValue({
      response: "done",
      aiCallCount: 4,
    } satisfies WorkerResult);

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(true);
    expect(result.turns[0].aiCallCount).toBe(4);
  });

  it("does not include aiCallCount on the completed turn when worker omits it", async () => {
    const config = makeConfig();
    (config.processor as any).processMessage.mockResolvedValue({
      response: "done",
    } satisfies WorkerResult);

    const result = await runMultiTurnLoop(config as any);

    expect(result.turns[0].aiCallCount).toBeUndefined();
  });

  it("includes aiCallCount on the partial turn when judge evaluation fails", async () => {
    const config = makeConfig({
      judgeClient: {
        evaluate: vi.fn().mockRejectedValue(new Error("judge down")),
      },
    });
    (config.processor as any).processMessage.mockResolvedValue({
      response: "done",
      aiCallCount: 7,
    } satisfies WorkerResult);

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(false);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].aiCallCount).toBe(7);
  });

  it("does not include aiCallCount on the partial turn when worker omits it and judge fails", async () => {
    const config = makeConfig({
      judgeClient: {
        evaluate: vi.fn().mockRejectedValue(new Error("judge down")),
      },
    });
    (config.processor as any).processMessage.mockResolvedValue({
      response: "done",
    } satisfies WorkerResult);

    const result = await runMultiTurnLoop(config as any);

    expect(result.turns[0].aiCallCount).toBeUndefined();
  });
});

describe("runMultiTurnLoop — optional criteria (issue #605)", () => {
  const mockLog = vi.fn().mockResolvedValue(undefined);
  const mockOnTurnComplete = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeHarFile.mockReset().mockResolvedValue({ log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] } });
    mockExtractToolCalls.mockReset().mockReturnValue([]);
  });

  function makeConfig(overrides: Record<string, unknown> = {}) {
    return {
      processor: {
        workerName: "test-worker",
        processMessage: vi.fn().mockResolvedValue({ response: "done" } satisfies WorkerResult),
      },
      task: "Do something",
      criteria: ["check"],
      maxIterations: 1,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: {
        uploadFile: vi.fn().mockResolvedValue("https://blob/har"),
        uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot"),
      } as any,
      requestId: "req1",
      runId: "attempt-1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
      ...overrides,
    };
  }

  it("skips judge and returns passed when maxIterations=1 and criteria is empty", async () => {
    const judgeEvaluate = vi.fn();
    const config = makeConfig({
      criteria: [],
      maxIterations: 1,
      judgeClient: { evaluate: judgeEvaluate },
    });

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(true);
    expect(result.hadError).toBe(false);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].passed).toBe(true);
    expect(result.turns[0].judgeFeedback).toContain("skipped");
    expect(judgeEvaluate).not.toHaveBeenCalled();
  });

  it("skips judge and returns passed when maxIterations=1 and criteria is undefined", async () => {
    const judgeEvaluate = vi.fn();
    const config = makeConfig({
      criteria: undefined,
      maxIterations: 1,
      judgeClient: { evaluate: judgeEvaluate },
    });

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(true);
    expect(result.hadError).toBe(false);
    expect(result.turns).toHaveLength(1);
    expect(judgeEvaluate).not.toHaveBeenCalled();
  });

  it("still calls judge when maxIterations=1 and criteria is provided", async () => {
    const judgeEvaluate = vi.fn().mockResolvedValue({ passed: true, feedback: "OK" });
    const config = makeConfig({
      criteria: ["has_button"],
      maxIterations: 1,
      judgeClient: { evaluate: judgeEvaluate },
    });

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(true);
    expect(judgeEvaluate).toHaveBeenCalledTimes(1);
  });

  it("throws when criteria is empty and maxIterations > 1", async () => {
    const config = makeConfig({
      criteria: [],
      maxIterations: 2,
    });

    await expect(runMultiTurnLoop(config as any)).rejects.toThrow(
      "Criteria is required when maxIterations > 1",
    );
  });

  it("throws when criteria is undefined and maxIterations > 1", async () => {
    const config = makeConfig({
      criteria: undefined,
      maxIterations: 3,
    });

    await expect(runMultiTurnLoop(config as any)).rejects.toThrow(
      "Criteria is required when maxIterations > 1",
    );
  });

  it("persists turn via onTurnComplete when judge is skipped", async () => {
    const config = makeConfig({
      criteria: [],
      maxIterations: 1,
    });

    await runMultiTurnLoop(config as any);

    expect(mockOnTurnComplete).toHaveBeenCalledTimes(1);
    expect(mockOnTurnComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        passed: true,
        snapshotUrl: "https://blob/snapshot",
      }),
    );
  });
});

describe("runMultiTurnLoop — per-iteration timeout", () => {
  const mockLog = vi.fn().mockResolvedValue(undefined);
  const mockOnTurnComplete = vi.fn().mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MULTI_TURN_DEFAULTS_REF: any;
  let originalTimeout: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSanitizeHarFile
      .mockReset()
      .mockResolvedValue({ log: { version: "1.2", creator: { name: "test", version: "1" }, entries: [] } });
    mockExtractToolCalls.mockReset().mockReturnValue([]);
    const mod = await import("@scope/core");
    MULTI_TURN_DEFAULTS_REF = mod.MULTI_TURN_DEFAULTS;
    originalTimeout = MULTI_TURN_DEFAULTS_REF.ITERATION_TIMEOUT_MS;
  });

  afterEach(() => {
    MULTI_TURN_DEFAULTS_REF.ITERATION_TIMEOUT_MS = originalTimeout;
  });

  function makeConfig(overrides: Record<string, unknown> = {}) {
    return {
      processor: {
        workerName: "test-worker",
        processMessage: vi.fn().mockResolvedValue({ response: "done" } satisfies WorkerResult),
      },
      task: "Do something",
      criteria: ["check"],
      maxIterations: 3,
      workspacePath: "/workspace",
      // Judge always fails so the loop continues to the next iteration unless aborted.
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: false, feedback: "try again" }) } as any,
      blobStorage: {
        uploadFile: vi.fn().mockResolvedValue("https://blob/x"),
        uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot"),
      } as any,
      requestId: "req1",
      runId: "attempt-1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
      ...overrides,
    };
  }

  it("aborts after the iteration that exceeds the per-iteration budget", async () => {
    // Tiny budget — any iteration with a small delay will exceed it.
    MULTI_TURN_DEFAULTS_REF.ITERATION_TIMEOUT_MS = 5;

    const processMessage = vi.fn().mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { response: "done" } satisfies WorkerResult;
      },
    );
    const config = makeConfig({
      processor: { workerName: "test-worker", processMessage },
    });

    const result = await runMultiTurnLoop(config as any);

    expect(result.passed).toBe(false);
    expect(result.hadError).toBe(true);
    expect(result.finalResult).toMatch(/Iteration 1 exceeded timeout/);
    // Iteration 1 completed (turn recorded), iteration 2 never started.
    expect(result.turns).toHaveLength(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT abort when individual iterations stay under budget even if cumulative time exceeds it (regression for cumulative-budget bug)", async () => {
    // Budget per iteration: 50ms. Each iteration sleeps 10ms (well under budget).
    // With the old cumulative-budget bug, three iterations sleeping 10ms each plus
    // overhead could trip a small budget. This test ensures only per-iteration
    // duration matters.
    MULTI_TURN_DEFAULTS_REF.ITERATION_TIMEOUT_MS = 50;

    const processMessage = vi.fn().mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { response: "done" } satisfies WorkerResult;
      },
    );
    // Judge passes on the 3rd iteration so we know the loop ran to completion.
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ passed: false, feedback: "again" })
      .mockResolvedValueOnce({ passed: false, feedback: "again" })
      .mockResolvedValueOnce({ passed: true, feedback: "ok" });
    const config = makeConfig({
      processor: { workerName: "test-worker", processMessage },
      judgeClient: { evaluate } as any,
      maxIterations: 3,
    });

    const result = await runMultiTurnLoop(config as any);

    expect(result.hadError).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.turns).toHaveLength(3);
    expect(processMessage).toHaveBeenCalledTimes(3);
  });
});
