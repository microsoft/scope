// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";

// ---------------------------------------------------------------------------
// Mocks – must be declared before importing the module under test
// ---------------------------------------------------------------------------

/** Captured session.on handler so tests can fire synthetic events */
let capturedEventHandler: ((event: SessionEvent) => void) | undefined;

const mockSendAndWait = vi.fn().mockResolvedValue(undefined);
const mockSessionOn = vi.fn((handler: (event: SessionEvent) => void) => {
  capturedEventHandler = handler;
  return () => {};
});
const mockCreateSession = vi.fn().mockResolvedValue({
  on: mockSessionOn,
  sendAndWait: mockSendAndWait,
});
const mockClientStop = vi.fn().mockResolvedValue([]);

vi.mock("@github/copilot-sdk", () => {
  class StubCopilotClient {
    createSession = mockCreateSession;
    stop = mockClientStop;
  }
  return { CopilotClient: StubCopilotClient };
});

vi.mock("@scope/worker-runtime", () => {
  // Minimal stub of BaseQueueProcessor – only what the constructor needs
  class StubBaseQueueProcessor {
    protected collection = { updateOne: vi.fn().mockResolvedValue({}) };
    constructor() {}
    protected safeDeleteMessage = vi.fn().mockResolvedValue(undefined);
  }
  return {
    BaseQueueProcessor: StubBaseQueueProcessor,
  };
});

vi.mock("@scope/secrets", () => {
  class StubTokenManagerClient {
    acquireToken = vi.fn().mockResolvedValue("fake-token");
  }
  return {
    TokenManagerClient: StubTokenManagerClient,
  };
});

vi.mock("@scope/core", () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock("./tools.js", () => ({
  createReportTools: vi.fn(() => []),
}));

vi.mock("./prompt.js", () => ({
  REPORT_SYSTEM_PROMPT: "You are a test prompt.",
}));

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{"version":"0.0.0-test"}'),
}));

vi.mock("os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
}));

import { ReportQueueProcessor } from "./report-queue-processor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    reportModel: "gpt-4.1",
    apiBaseUrl: "http://localhost:3000",
    sessionTimeoutMs: 5000,
    // BaseQueueProcessor plumbing – values don't matter for these tests
    queueName: "report-queue",
    connectionString: "DefaultEndpointsProtocol=https;AccountName=fake",
    mongoUri: "mongodb://localhost:27017",
    mongoDb: "test",
    collectionName: "reports",
  } as any;
}

/**
 * Access the private `runCopilotSession` method via type escape.
 * This lets us test event-handler behaviour in isolation.
 */
async function callRunCopilotSession(
  processor: ReportQueueProcessor,
  log: ReturnType<typeof vi.fn>,
  model = "gpt-4.1",
  timeoutMs = 5000,
) {
  return (processor as any).runCopilotSession([], "Generate a report for run req-123", "You are an expert analyst.", model, timeoutMs, log);
}

function makeBaseEvent(type: string, data: Record<string, unknown> = {}): SessionEvent {
  return {
    id: "evt-1",
    timestamp: new Date().toISOString(),
    parentId: null,
    type,
    data,
  } as unknown as SessionEvent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReportQueueProcessor – session event logging", () => {
  let processor: ReportQueueProcessor;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedEventHandler = undefined;
    log = vi.fn().mockResolvedValue(undefined);
    processor = new ReportQueueProcessor(makeConfig());

    // Ensure sendAndWait triggers captured handler with a delta so response is non-empty
    mockSendAndWait.mockImplementation(async () => {
      if (capturedEventHandler) {
        capturedEventHandler(makeBaseEvent("assistant.message_delta", {
          messageId: "m1",
          deltaContent: "Report content goes here.",
        }));
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs 'Acquired Copilot SDK token' before creating a session", async () => {
    await callRunCopilotSession(processor, log);

    expect(log).toHaveBeenCalledWith("info", "Acquired Copilot SDK token");
  });

  it("logs session.start events with sessionId and model", async () => {
    mockSendAndWait.mockImplementation(async () => {
      capturedEventHandler!(makeBaseEvent("session.start", {
        sessionId: "sess-42",
        selectedModel: "gpt-4.1",
        version: 1,
        producer: "test",
        copilotVersion: "1.0",
        startTime: new Date().toISOString(),
      }));
      // Need non-empty response
      capturedEventHandler!(makeBaseEvent("assistant.message_delta", {
        messageId: "m1",
        deltaContent: "ok",
      }));
    });

    await callRunCopilotSession(processor, log);

    expect(log).toHaveBeenCalledWith("info", "Copilot session started", {
      sessionId: "sess-42",
      model: "gpt-4.1",
    });
  });

  it("logs session.error events at error level", async () => {
    mockSendAndWait.mockImplementation(async () => {
      capturedEventHandler!(makeBaseEvent("session.error", {
        errorType: "rate_limit",
        message: "Rate limit exceeded",
      }));
      capturedEventHandler!(makeBaseEvent("assistant.message_delta", {
        messageId: "m1",
        deltaContent: "partial",
      }));
    });

    await callRunCopilotSession(processor, log);

    expect(log).toHaveBeenCalledWith("error", "Session error: Rate limit exceeded", {
      errorType: "rate_limit",
    });
  });

  it("logs session.info events", async () => {
    mockSendAndWait.mockImplementation(async () => {
      capturedEventHandler!(makeBaseEvent("session.info", {
        infoType: "general",
        message: "Model switched",
      }));
      capturedEventHandler!(makeBaseEvent("assistant.message_delta", {
        messageId: "m1",
        deltaContent: "content",
      }));
    });

    await callRunCopilotSession(processor, log);

    expect(log).toHaveBeenCalledWith("info", "Session: Model switched");
  });

  it("logs assistant.turn_start and assistant.turn_end", async () => {
    mockSendAndWait.mockImplementation(async () => {
      capturedEventHandler!(makeBaseEvent("assistant.turn_start", { turnId: "t1" }));
      capturedEventHandler!(makeBaseEvent("assistant.message_delta", {
        messageId: "m1",
        deltaContent: "text",
      }));
      capturedEventHandler!(makeBaseEvent("assistant.turn_end", { turnId: "t1" }));
    });

    await callRunCopilotSession(processor, log);

    expect(log).toHaveBeenCalledWith("info", "Assistant turn started", { turnId: "t1" });
    expect(log).toHaveBeenCalledWith("info", "Assistant turn ended", { turnId: "t1" });
  });

  it("logs tool.execution_start with tool name and arguments", async () => {
    mockSendAndWait.mockImplementation(async () => {
      capturedEventHandler!(makeBaseEvent("tool.execution_start", {
        toolCallId: "tc-1",
        toolName: "get_run_summary",
        arguments: { foo: "bar" },
      }));
      capturedEventHandler!(makeBaseEvent("tool.execution_complete", {
        toolCallId: "tc-1",
        success: true,
      }));
      capturedEventHandler!(makeBaseEvent("assistant.message_delta", {
        messageId: "m1",
        deltaContent: "done",
      }));
    });

    await callRunCopilotSession(processor, log);

    expect(log).toHaveBeenCalledWith("info", "Tool call: get_run_summary", {
      toolCallId: "tc-1",
      arguments: { foo: "bar" },
    });
  });

  it("logs tool.execution_complete with success status", async () => {
    mockSendAndWait.mockImplementation(async () => {
      capturedEventHandler!(makeBaseEvent("tool.execution_start", {
        toolCallId: "tc-2",
        toolName: "list_turns",
      }));
      capturedEventHandler!(makeBaseEvent("tool.execution_complete", {
        toolCallId: "tc-2",
        success: true,
      }));
      capturedEventHandler!(makeBaseEvent("assistant.message_delta", {
        messageId: "m1",
        deltaContent: "result",
      }));
    });

    await callRunCopilotSession(processor, log);

    expect(log).toHaveBeenCalledWith("info", "Tool result: list_turns (success)", {
      toolCallId: "tc-2",
    });
  });

  it("logs tool.execution_complete with failure and error message", async () => {
    mockSendAndWait.mockImplementation(async () => {
      capturedEventHandler!(makeBaseEvent("tool.execution_start", {
        toolCallId: "tc-3",
        toolName: "extract_snapshot",
      }));
      capturedEventHandler!(makeBaseEvent("tool.execution_complete", {
        toolCallId: "tc-3",
        success: false,
        error: { message: "Not found", code: "404" },
      }));
      capturedEventHandler!(makeBaseEvent("assistant.message_delta", {
        messageId: "m1",
        deltaContent: "fallback",
      }));
    });

    await callRunCopilotSession(processor, log);

    expect(log).toHaveBeenCalledWith("info", "Tool result: extract_snapshot (failed)", {
      toolCallId: "tc-3",
      error: "Not found",
    });
  });

  it("logs unknown tool name as 'unknown' when no matching start event", async () => {
    mockSendAndWait.mockImplementation(async () => {
      // Complete event without a preceding start event
      capturedEventHandler!(makeBaseEvent("tool.execution_complete", {
        toolCallId: "tc-orphan",
        success: true,
      }));
      capturedEventHandler!(makeBaseEvent("assistant.message_delta", {
        messageId: "m1",
        deltaContent: "ok",
      }));
    });

    await callRunCopilotSession(processor, log);

    expect(log).toHaveBeenCalledWith("info", "Tool result: unknown (success)", {
      toolCallId: "tc-orphan",
    });
  });

  it("throttles delta progress logs to every ~2000 chars", async () => {
    mockSendAndWait.mockImplementation(async () => {
      // Send many small deltas totalling ~5000 chars
      const chunk = "x".repeat(500);
      for (let i = 0; i < 10; i++) {
        capturedEventHandler!(makeBaseEvent("assistant.message_delta", {
          messageId: "m1",
          deltaContent: chunk,
        }));
      }
    });

    await callRunCopilotSession(processor, log);

    // Should get progress logs at ~2000, ~4000 chars (2 progress logs)
    const progressCalls = log.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[1] === "string" && (call[1] as string).includes("chars so far"),
    );
    expect(progressCalls.length).toBe(2);
    expect(progressCalls[0][1]).toContain("2000");
    expect(progressCalls[1][1]).toContain("4000");
  });

  it("does not log delta progress for small responses", async () => {
    // Default mock sends 25 chars, well under 2000 threshold
    await callRunCopilotSession(processor, log);

    const progressCalls = log.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[1] === "string" && (call[1] as string).includes("chars so far"),
    );
    expect(progressCalls.length).toBe(0);
  });

  it("throws when Copilot SDK returns empty response", async () => {
    mockSendAndWait.mockImplementation(async () => {
      // No delta events → empty response
    });

    await expect(callRunCopilotSession(processor, log)).rejects.toThrow(
      "Copilot SDK returned an empty response",
    );
  });

  it("calls client.stop() even if session throws", async () => {
    mockSendAndWait.mockRejectedValue(new Error("session boom"));

    await expect(callRunCopilotSession(processor, log)).rejects.toThrow("session boom");
    expect(mockClientStop).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleRequest – template validation
// ---------------------------------------------------------------------------

describe("ReportQueueProcessor – handleRequest template validation", () => {
  let processor: ReportQueueProcessor;
  let log: ReturnType<typeof vi.fn>;
  let mockUpdateOne: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedEventHandler = undefined;
    log = vi.fn().mockResolvedValue(undefined);
    processor = new ReportQueueProcessor(makeConfig());
    mockUpdateOne = (processor as any).collection.updateOne;

    // Reset fetch mock
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeMessage() {
    return {
      messageId: "msg-1",
      popReceipt: "pop-1",
      messageText: "",
      dequeueCount: 1,
      expiresOn: new Date(),
      insertedOn: new Date(),
      nextVisibleOn: new Date(),
    };
  }

  function makeReportDoc(overrides: Partial<import("@scope/core").ReportDocument> = {}): import("@scope/core").ReportDocument {
    return {
      _id: "report-1",
      requestId: "req-1",
      status: "pending",
      logs: [],
      createdAt: new Date(),
      ...overrides,
    } as import("@scope/core").ReportDocument;
  }

  it("throws when report has no templateId", async () => {
    const doc = makeReportDoc({ templateId: undefined });

    await expect(
      (processor as any).handleRequest(doc, makeMessage(), "pop-1", log)
    ).rejects.toThrow("has no templateId");

    // Status should NOT be set to "generating" since template validation fails first
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("throws when templateId points to a non-existent template", async () => {
    const doc = makeReportDoc({ templateId: "nonexistent-template" });

    // Mock fetch to return 404 (fetchReportTemplate returns null)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }));

    await expect(
      (processor as any).handleRequest(doc, makeMessage(), "pop-1", log)
    ).rejects.toThrow("Report template 'nonexistent-template' not found");
  });
});

// ---------------------------------------------------------------------------
// runCopilotSession – model parameter
// ---------------------------------------------------------------------------

describe("ReportQueueProcessor – model selection", () => {
  let processor: ReportQueueProcessor;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedEventHandler = undefined;
    log = vi.fn().mockResolvedValue(undefined);
    processor = new ReportQueueProcessor(makeConfig());

    mockSendAndWait.mockImplementation(async () => {
      if (capturedEventHandler) {
        capturedEventHandler(makeBaseEvent("assistant.message_delta", {
          messageId: "m1",
          deltaContent: "report content",
        }));
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the provided model to createSession", async () => {
    await callRunCopilotSession(processor, log, "claude-sonnet-4");

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4" })
    );
  });

  it("uses default config model when called with config model", async () => {
    await callRunCopilotSession(processor, log, "gpt-4.1");

    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4.1" })
    );
  });
});
