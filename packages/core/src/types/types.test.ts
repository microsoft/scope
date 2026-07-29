// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { WorkerProcessor, WorkerProcessorOptions, WorkerResult, LogEvent, CodingAgentDocument, InsightDocument, InsightReference } from "./types.js";

describe("WorkerProcessorOptions", () => {
  it("passes model through processMessage", async () => {
    const receivedOptions: WorkerProcessorOptions[] = [];

    const processor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(
        _message: string,
        _log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
        options?: WorkerProcessorOptions
      ): Promise<WorkerResult> {
        if (options) receivedOptions.push(options);
        return { response: "done" };
      },
    };

    const log = vi.fn();

    await processor.processMessage("task", log, { model: "gpt-4.1" });
    expect(receivedOptions).toHaveLength(1);
    expect(receivedOptions[0].model).toBe("gpt-4.1");
  });

  it("allows processMessage without options", async () => {
    const processor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "done" };
      },
    };

    const log = vi.fn();
    const result = await processor.processMessage("task", log);
    expect(result).toEqual({ response: "done" });
  });

  it("allows processMessage with undefined model", async () => {
    let receivedModel: string | undefined = "not-set";

    const processor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(
        _message: string,
        _log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
        options?: WorkerProcessorOptions
      ): Promise<WorkerResult> {
        receivedModel = options?.model;
        return { response: "done" };
      },
    };

    const log = vi.fn();
    await processor.processMessage("task", log, {});
    expect(receivedModel).toBeUndefined();
  });
});

describe("CodingAgentDocument", () => {
  it("supports all required fields", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-acp-copilot",
      name: "GitHub Copilot CLI",
      supportedModels: ["gpt-4.1", "claude-sonnet-4"],
      defaultModel: "gpt-4.1",
      createdAt: new Date(),
    };

    expect(agent._id).toBe("coder-acp-copilot");
    expect(agent.name).toBe("GitHub Copilot CLI");
    expect(agent.supportedModels).toEqual(["gpt-4.1", "claude-sonnet-4"]);
    expect(agent.defaultModel).toBe("gpt-4.1");
    expect(agent.deletedAt).toBeUndefined();
  });

  it("supports empty supportedModels (model selection disabled)", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-vscode-web",
      name: "VS Code Copilot (Web)",
      supportedModels: [],
      createdAt: new Date(),
    };

    expect(agent.supportedModels).toEqual([]);
    expect(agent.defaultModel).toBeUndefined();
  });

  it("supports soft-delete with deletedAt", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-acp-claude-code",
      name: "Claude Code CLI",
      supportedModels: ["claude-sonnet-4"],
      defaultModel: "claude-sonnet-4",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-06-01"),
      deletedAt: new Date("2025-06-15"),
    };

    expect(agent.deletedAt).toBeInstanceOf(Date);
  });

  it("validates defaultModel is in supportedModels (application-level check)", () => {
    const agent: CodingAgentDocument = {
      _id: "test-agent",
      name: "Test Agent",
      supportedModels: ["model-a", "model-b"],
      defaultModel: "model-a",
      createdAt: new Date(),
    };

    // Application-level validation: defaultModel should be in supportedModels
    expect(agent.supportedModels).toContain(agent.defaultModel);
  });

  it("supports optional modelProvider field", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-acp-copilot",
      name: "GitHub Copilot CLI",
      modelProvider: "github-copilot",
      supportedModels: ["gpt-4.1"],
      createdAt: new Date(),
    };

    expect(agent.modelProvider).toBe("github-copilot");

    const agentWithout: CodingAgentDocument = {
      _id: "test-agent",
      name: "Test",
      supportedModels: [],
      createdAt: new Date(),
    };

    expect(agentWithout.modelProvider).toBeUndefined();
  });
});

describe("InsightDocument", () => {
  it("supports all required fields", () => {
    const insight: InsightDocument = {
      _id: "abc-123",
      title: "Agent retries same approach despite failure",
      description: "## Observation\nThe agent repeatedly attempts the same fix.",
      upvotes: 3,
      downvotes: 1,
      blocked: false,
      referenceCount: 5,
      createdBy: "agent",
      createdAt: new Date(),
    };

    expect(insight._id).toBe("abc-123");
    expect(insight.createdBy).toBe("agent");
    expect(insight.referenceCount).toBe(5);
    expect(insight.blocked).toBe(false);
    expect(insight.category).toBeUndefined();
    expect(insight.tags).toBeUndefined();
    expect(insight.deletedAt).toBeUndefined();
  });

  it("supports optional fields", () => {
    const insight: InsightDocument = {
      _id: "def-456",
      title: "Scenario criteria too vague",
      description: "Details here",
      category: "scenario-design",
      tags: ["criteria", "vague", "improvement"],
      upvotes: 0,
      downvotes: 0,
      blocked: false,
      referenceCount: 1,
      createdBy: "user",
      sourceReportId: "report-789",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-06-01"),
      deletedAt: new Date("2025-06-15"),
    };

    expect(insight.category).toBe("scenario-design");
    expect(insight.tags).toEqual(["criteria", "vague", "improvement"]);
    expect(insight.sourceReportId).toBe("report-789");
    expect(insight.deletedAt).toBeInstanceOf(Date);
  });

  it("allows createdBy to be agent or user", () => {
    const agentInsight: InsightDocument = {
      _id: "1",
      title: "t",
      description: "d",
      upvotes: 0,
      downvotes: 0,
      blocked: false,
      referenceCount: 0,
      createdBy: "agent",
      createdAt: new Date(),
    };

    const userInsight: InsightDocument = {
      ...agentInsight,
      _id: "2",
      createdBy: "user",
    };

    expect(agentInsight.createdBy).toBe("agent");
    expect(userInsight.createdBy).toBe("user");
  });
});

describe("InsightReference", () => {
  it("supports new insight reference", () => {
    const ref: InsightReference = {
      insightId: "insight-1",
      referencedAt: new Date(),
      isNew: true,
    };

    expect(ref.isNew).toBe(true);
  });

  it("supports existing insight reference", () => {
    const ref: InsightReference = {
      insightId: "insight-2",
      referencedAt: new Date(),
      isNew: false,
    };

    expect(ref.isNew).toBe(false);
  });
});
