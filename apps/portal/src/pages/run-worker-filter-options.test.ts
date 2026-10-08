// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { CodingAgent, RunFacetBucket } from "@/types";
import { buildRunWorkerFilterOptions } from "./run-worker-filter-options";

function agent(
  id: string,
  name: string,
  available: boolean,
): CodingAgent {
  return {
    _id: id,
    name,
    available,
    supportedModels: [],
    createdAt: "2026-08-27T00:00:00Z",
    versions: available
      ? [{
          agentVersion: "v1",
          workerVersion: "v1",
          components: {},
          gitCommit: "abc",
          buildTime: "2026-08-27T00:00:00Z",
          imageTag: "v1",
          queueName: `queue-${id}`,
          status: "active",
          createdAt: "2026-08-27T00:00:00Z",
        }]
      : [],
  };
}

describe("buildRunWorkerFilterOptions", () => {
  const agents = [
    agent("coder-acp-copilot", "GitHub Copilot CLI", true),
    agent("coder-acp-claude-code", "Claude Code CLI", false),
  ];

  it("shows available agents even when they have no runs", () => {
    expect(buildRunWorkerFilterOptions(agents, [])).toEqual([
      {
        value: "coder-acp-copilot",
        label: "GitHub Copilot CLI",
        count: 0,
      },
    ]);
  });

  it("shows unavailable agents when they have historical runs", () => {
    const buckets: RunFacetBucket[] = [
      { value: "coder-acp-claude-code", count: 3 },
    ];

    expect(buildRunWorkerFilterOptions(agents, buckets)).toEqual([
      {
        value: "coder-acp-claude-code",
        label: "Claude Code CLI",
        count: 3,
      },
      {
        value: "coder-acp-copilot",
        label: "GitHub Copilot CLI",
        count: 0,
      },
    ]);
  });

  it("uses a deleted agent's saved name for historical runs", () => {
    const deleted = {
      ...agent("deleted-agent", "Retired worker", false),
      deletedAt: "2026-09-01T00:00:00Z",
    };

    expect(
      buildRunWorkerFilterOptions(
        [...agents, deleted],
        [{ value: deleted._id, count: 2 }],
      ),
    ).toContainEqual({
      value: deleted._id,
      label: deleted.name,
      count: 2,
    });
  });

  it("does not expose an unknown historical agent id as its label", () => {
    expect(
      buildRunWorkerFilterOptions(
        agents,
        [{ value: "missing-agent", count: 1 }],
      ),
    ).toContainEqual({
      value: "missing-agent",
      label: "Unknown agent",
      count: 1,
    });
  });
});
