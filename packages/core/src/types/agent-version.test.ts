// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkerProcessor, WorkerResult, LogEvent, AgentVersion, CodingAgentDocument, RequestDocument } from "../types/types.js";

describe("AgentVersion type", () => {
  it("can create a valid AgentVersion object", () => {
    const version: AgentVersion = {
      agentVersion: "copilot-0.0.415",
      workerVersion: "copilot-0.0.415-20260318T163740Z-44d16d6",
      components: { COPILOT_CLI_VERSION: "0.0.415" },
      gitCommit: "44d16d6",
      buildTime: "20260318T163740Z",
      imageTag: "copilot-0.0.415-20260318T163740Z-44d16d6",
      queueName: "coder-acp-copilot",
      status: "active",
      createdAt: new Date(),
    };

    expect(version.agentVersion).toBe("copilot-0.0.415");
    expect(version.workerVersion).toBe("copilot-0.0.415-20260318T163740Z-44d16d6");
    expect(version.status).toBe("active");
    expect(version.components.COPILOT_CLI_VERSION).toBe("0.0.415");
  });

  it("supports multi-component agents (vscode-web)", () => {
    const version: AgentVersion = {
      agentVersion: "vscode-1.111.0-copilot-0.39.0",
      workerVersion: "vscode-1.111.0-copilot-0.39.0-20260318T163731Z-44d16d6",
      components: { VSCODE_VERSION: "1.111.0", COPILOT_CHAT_VERSION: "0.39.0" },
      gitCommit: "44d16d6",
      buildTime: "20260318T163731Z",
      imageTag: "vscode-1.111.0-copilot-0.39.0-20260318T163731Z-44d16d6",
      queueName: "coder-vscode-web",
      status: "active",
      createdAt: new Date(),
    };

    expect(Object.keys(version.components)).toHaveLength(2);
    expect(version.agentVersion).toBe("vscode-1.111.0-copilot-0.39.0");
  });

  it("supports claude-code with sdk version", () => {
    const version: AgentVersion = {
      agentVersion: "claude-agent-acp-0.29.0-sdk-0.2.111",
      workerVersion: "claude-agent-acp-0.29.0-sdk-0.2.111-20260318T163730Z-44d16d6",
      components: { CLAUDE_CODE_ACP_VERSION: "0.29.0", CLAUDE_AGENT_SDK_VERSION: "0.2.111" },
      gitCommit: "44d16d6",
      buildTime: "20260318T163730Z",
      imageTag: "claude-agent-acp-0.29.0-sdk-0.2.111-20260318T163730Z-44d16d6",
      queueName: "coder-acp-claude-code",
      status: "active",
      createdAt: new Date(),
    };

    expect(version.agentVersion).toBe("claude-agent-acp-0.29.0-sdk-0.2.111");
  });

  it("supports retired status", () => {
    const version: AgentVersion = {
      agentVersion: "copilot-0.0.414",
      workerVersion: "copilot-0.0.414-20260317T120000Z-abc1234",
      components: { COPILOT_CLI_VERSION: "0.0.414" },
      gitCommit: "abc1234",
      buildTime: "20260317T120000Z",
      imageTag: "copilot-0.0.414-20260317T120000Z-abc1234",
      queueName: "coder-acp-copilot",
      status: "retired",
      createdAt: new Date(),
    };

    expect(version.status).toBe("retired");
  });
});

describe("CodingAgentDocument with versions", () => {
  it("supports versions array", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-acp-copilot",
      name: "GitHub Copilot CLI",
      supportedModels: ["gpt-4.1"],
      createdAt: new Date(),
      versions: [
        {
          agentVersion: "copilot-0.0.415",
          workerVersion: "copilot-0.0.415-20260318T163740Z-44d16d6",
          components: { COPILOT_CLI_VERSION: "0.0.415" },
          gitCommit: "44d16d6",
          buildTime: "20260318T163740Z",
          imageTag: "copilot-0.0.415-20260318T163740Z-44d16d6",
          queueName: "coder-acp-copilot",
          status: "active",
          createdAt: new Date(),
        },
      ],
    };

    expect(agent.versions).toHaveLength(1);
    expect(agent.versions![0].agentVersion).toBe("copilot-0.0.415");
  });

  it("allows empty versions array", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-acp-copilot",
      name: "GitHub Copilot CLI",
      supportedModels: [],
      createdAt: new Date(),
      versions: [],
    };

    expect(agent.versions).toHaveLength(0);
  });

  it("allows undefined versions (backward compatible)", () => {
    const agent: CodingAgentDocument = {
      _id: "coder-acp-copilot",
      name: "GitHub Copilot CLI",
      supportedModels: [],
      createdAt: new Date(),
    };

    expect(agent.versions).toBeUndefined();
  });
});

describe("RequestDocument version fields", () => {
  it("supports agentVersion at root and workerVersion in run", () => {
    const doc: Partial<RequestDocument> = {
      agentVersion: "copilot-0.0.415",
      run: { _id: "r1", attemptNumber: 1, status: "done", workerVersion: "copilot-0.0.415-20260318T163740Z-44d16d6" },
    };

    expect(doc.agentVersion).toBe("copilot-0.0.415");
    expect(doc.run?.workerVersion).toBe("copilot-0.0.415-20260318T163740Z-44d16d6");
  });

  it("allows both fields to be undefined (backward compatible)", () => {
    const doc: Partial<RequestDocument> = {};

    expect(doc.agentVersion).toBeUndefined();
    expect(doc.run).toBeUndefined();
  });
});

describe("WorkerProcessor.getComponentVersions", () => {
  it("returns component env vars", () => {
    const processor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "done" };
      },
      getAgentVersion() {
        return "copilot-0.0.415";
      },
      getComponentVersions() {
        return { COPILOT_CLI_VERSION: "0.0.415" };
      },
    };

    expect(processor.getComponentVersions!()).toEqual({ COPILOT_CLI_VERSION: "0.0.415" });
    expect(processor.getAgentVersion!()).toBe("copilot-0.0.415");
  });

  it("is optional on WorkerProcessor", () => {
    const processor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "done" };
      },
    };

    expect(processor.getComponentVersions).toBeUndefined();
    expect(processor.getAgentVersion).toBeUndefined();
  });
});
