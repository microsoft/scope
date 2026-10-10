// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  agentSupportsExtensions,
  getActiveAgentVersions,
  hasExtensionCapableAgent,
  isAgentAvailable,
  isAgentVersionAvailable,
  type CodingAgent,
} from "./types";

function agent(queueName?: string): CodingAgent {
  return {
    _id: "legacy-worker",
    name: "Legacy Worker",
    available: true,
    supportedModels: [],
    versions: [
      {
        agentVersion: "v1",
        workerVersion: "v1",
        components: {},
        gitCommit: "abcdef0",
        buildTime: "20260101T000000Z",
        imageTag: "v1",
        queueName,
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("agent availability", () => {
  it.each([undefined, "", "   "])(
    "treats a legacy %p queue name as unavailable",
    (queueName) => {
      const legacyAgent = agent(queueName);

      expect(getActiveAgentVersions(legacyAgent)).toEqual([]);
      expect(isAgentAvailable(legacyAgent)).toBe(false);
    },
  );

  it("accepts an active version with an advertised queue", () => {
    expect(isAgentAvailable(agent("synthetic-dynamic-queue"))).toBe(true);
    expect(isAgentVersionAvailable(agent("synthetic-dynamic-queue"), "v1")).toBe(true);
    expect(isAgentVersionAvailable(agent("synthetic-dynamic-queue"), "retired")).toBe(false);
  });
});

describe("extensions support", () => {
  const withExtensions = (overrides: Partial<CodingAgent> = {}): CodingAgent => ({
    ...agent("queue"),
    capabilities: { supportsExtensions: true },
    ...overrides,
  });

  it("requires an explicit supportsExtensions opt-in", () => {
    expect(agentSupportsExtensions(undefined)).toBe(false);
    expect(agentSupportsExtensions(agent("queue"))).toBe(false);
    expect(agentSupportsExtensions(withExtensions({ capabilities: { supportsExtensions: false } }))).toBe(false);
    expect(agentSupportsExtensions(withExtensions())).toBe(true);
  });

  it("is active only when an available agent opts in", () => {
    expect(hasExtensionCapableAgent([])).toBe(false);
    expect(hasExtensionCapableAgent([agent("queue")])).toBe(false);
    expect(hasExtensionCapableAgent([withExtensions({ deletedAt: "2026-01-02T00:00:00Z" })])).toBe(false);
    expect(hasExtensionCapableAgent([withExtensions({ available: false })])).toBe(false);
    expect(hasExtensionCapableAgent([{ ...agent(undefined), capabilities: { supportsExtensions: true } }])).toBe(false);
    expect(hasExtensionCapableAgent([agent("queue"), withExtensions()])).toBe(true);
  });
});
