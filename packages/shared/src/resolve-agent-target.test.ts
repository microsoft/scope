// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { CodingAgentDocument } from "./types/types.js";
import { resolveAgentTarget } from "./resolve-agent-target.js";

function agent(
  overrides: Partial<CodingAgentDocument> = {},
): CodingAgentDocument {
  return {
    _id: "synthetic-worker",
    name: "Synthetic Worker",
    available: true,
    supportedModels: [],
    capabilities: {
      supportsReasoningEffort: true,
      supportsMcpServers: true,
    },
    versions: [
      {
        agentVersion: "v1",
        workerVersion: "v1-build",
        components: {},
        gitCommit: "abcdef0",
        buildTime: "20260101T000000Z",
        imageTag: "v1-build",
        queueName: "synthetic-custom-queue",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ],
    createdAt: new Date(),
    ...overrides,
  };
}

describe("resolveAgentTarget", () => {
  it("requires registration", () => {
    expect(resolveAgentTarget(null, undefined)).toMatchObject({
      errorCode: "agent_not_found",
    });
  });

  it("rejects deleted and unavailable agents", () => {
    expect(
      resolveAgentTarget(agent({ deletedAt: new Date() }), undefined),
    ).toMatchObject({ errorCode: "agent_deleted" });
    expect(resolveAgentTarget(agent({ available: false }), undefined)).toMatchObject(
      { errorCode: "agent_unavailable" },
    );
    expect(
      resolveAgentTarget(agent({ available: undefined }), undefined),
    ).toMatchObject({ errorCode: "agent_unavailable" });
  });

  it("requires an active version with an advertised queue", () => {
    expect(
      resolveAgentTarget(agent({ versions: [] }), undefined),
    ).toMatchObject({ errorCode: "agent_version_unavailable" });
    expect(
      resolveAgentTarget(
        agent({
          versions: [
            {
              ...agent().versions![0],
              queueName: " ",
            },
          ],
        }),
        undefined,
      ),
    ).toMatchObject({ errorCode: "agent_queue_missing" });
    expect(
      resolveAgentTarget(
        agent({
          versions: [
            {
              ...agent().versions![0],
              queueName: undefined,
            },
          ],
        }),
        undefined,
      ),
    ).toMatchObject({ errorCode: "agent_queue_missing" });
  });

  it("routes a requested active version to its exact queue", () => {
    expect(resolveAgentTarget(agent(), "v1")).toMatchObject({
      agentVersion: "v1",
      queueName: "synthetic-custom-queue",
    });
  });

  it("treats omitted capability flags as unsupported in strict mode", () => {    expect(
      resolveAgentTarget(
        agent(),
        undefined,
        { skills: true, extensions: true },
        true,
      ),
    ).toMatchObject({
      errorCode: "agent_capability_unsupported",
      unsupportedCapabilities: ["supportsSkills", "supportsExtensions"],
    });
  });

  it("rejects a resource-backed run on a worker that does not provision resources", () => {
    // Resources are only provisioned by workers that opt in. Without this check a
    // run's declared database or simulator is silently never stood up, and the
    // benchmark reports a result for an environment that never existed.
    expect(
      resolveAgentTarget(agent(), undefined, { resources: true }, true),
    ).toMatchObject({
      errorCode: "agent_capability_unsupported",
      unsupportedCapabilities: ["supportsResources"],
    });
  });

  it("routes a resource-backed run to a worker advertising supportsResources", () => {
    const resourceAgent = agent();
    resourceAgent.capabilities = { ...resourceAgent.capabilities, supportsResources: true };
    expect(
      resolveAgentTarget(resourceAgent, undefined, { resources: true }, true),
    ).toMatchObject({ agentVersion: "v1", queueName: "synthetic-custom-queue" });
  });

  it("keeps capability enforcement disabled during rollout when strict mode is off", () => {
    expect(
      resolveAgentTarget(
        agent(),
        undefined,
        { skills: true, extensions: true },
        false,
      ),
    ).toMatchObject({
      agentVersion: "v1",
      queueName: "synthetic-custom-queue",
    });
  });
});
