// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { resolveAgentVersion } from "./resolve-agent-version.js";
import type { AgentVersion } from "./types/types.js";

function makeVersion(overrides: Partial<AgentVersion> & { agentVersion: string }): AgentVersion {
  return {
    workerVersion: `${overrides.agentVersion}-20260318T163740Z-44d16d6`,
    components: { COPILOT_CLI_VERSION: "0.0.415" },
    gitCommit: "44d16d6",
    buildTime: "20260318T163740Z",
    imageTag: `${overrides.agentVersion}-20260318T163740Z-44d16d6`,
    queueName: "queue-coder-acp-copilot",
    status: "active",
    createdAt: new Date("2026-03-18T16:00:00Z"),
    ...overrides,
  };
}

describe("resolveAgentVersion", () => {
  const v1 = makeVersion({
    agentVersion: "copilot-0.0.414",
    queueName: "queue-copilot-0.0.414",
    createdAt: new Date("2026-03-17T10:00:00Z"),
  });
  const v2 = makeVersion({
    agentVersion: "copilot-0.0.415",
    queueName: "queue-copilot-0.0.415",
    createdAt: new Date("2026-03-18T16:00:00Z"),
  });
  const retired = makeVersion({
    agentVersion: "copilot-0.0.413",
    queueName: "queue-copilot-0.0.413",
    status: "retired",
    createdAt: new Date("2026-03-16T10:00:00Z"),
  });

  describe("explicit version selection", () => {
    it("returns the requested version when it exists and is active", () => {
      const result = resolveAgentVersion([v1, v2, retired], "copilot-0.0.414");
      expect(result).toEqual({
        agentVersion: "copilot-0.0.414",
        queueName: "queue-copilot-0.0.414",
      });
    });

    it("returns error when requested version is not found", () => {
      const result = resolveAgentVersion([v1, v2], "copilot-0.0.999");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("copilot-0.0.999");
        expect(result.activeVersions).toEqual(["copilot-0.0.414", "copilot-0.0.415"]);
      }
    });

    it("returns error when requested version exists but is retired", () => {
      const result = resolveAgentVersion([v1, v2, retired], "copilot-0.0.413");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("copilot-0.0.413");
      }
    });
  });

  describe("auto-selection (no version requested)", () => {
    it("returns the latest active version by createdAt", () => {
      const result = resolveAgentVersion([v1, v2, retired], undefined);
      expect(result).toEqual({
        agentVersion: "copilot-0.0.415",
        queueName: "queue-copilot-0.0.415",
      });
    });

    it("returns latest even when versions are in non-chronological order", () => {
      const result = resolveAgentVersion([v2, v1], undefined);
      expect(result).toEqual({
        agentVersion: "copilot-0.0.415",
        queueName: "queue-copilot-0.0.415",
      });
    });

    it("returns error when no active versions exist", () => {
      const result = resolveAgentVersion([retired], undefined);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("No active versions");
        expect(result.activeVersions).toEqual([]);
      }
    });

    it("returns error when versions array is empty", () => {
      const result = resolveAgentVersion([], undefined);
      expect("error" in result).toBe(true);
    });

    it("returns error when versions is undefined", () => {
      const result = resolveAgentVersion(undefined, undefined);
      expect("error" in result).toBe(true);
    });

    it("selects the only active version when there is exactly one", () => {
      const result = resolveAgentVersion([v1], undefined);
      expect(result).toEqual({
        agentVersion: "copilot-0.0.414",
        queueName: "queue-copilot-0.0.414",
      });
    });
  });
});
