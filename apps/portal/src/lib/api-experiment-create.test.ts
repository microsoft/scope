// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { setSelectedProjectIdHolder } from "./project-scope";

const apiClientMock = vi.hoisted(() => vi.fn());

vi.mock("./api-client", () => ({ apiClient: apiClientMock }));

const experiment = {
  experimentId: "experiment-1",
  projectId: "project-1",
  metadata: { name: "Experiment" },
  revision: {
    experimentRevisionId: "revision-1",
    revisionNumber: 1,
    memberCount: 1,
  },
  execution: {
    experimentExecutionId: "execution-1",
    attemptNumber: 1,
    requests: [],
    handlerProgress: {},
    blocking: [],
    createdAt: "2026-10-29T00:00:00.000Z",
  },
  blocking: [],
  createdRequestIds: [],
  createdAt: "2026-10-29T00:00:00.000Z",
};

function response() {
  return new Response(JSON.stringify({ experiment, requestIds: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function postedBody(): Record<string, unknown> {
  const init = apiClientMock.mock.calls[0]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("Experiment create API adapter", () => {
  beforeEach(() => {
    apiClientMock.mockReset();
    apiClientMock.mockResolvedValue(response());
    setSelectedProjectIdHolder("project-1");
  });

  afterEach(() => {
    setSelectedProjectIdHolder(undefined);
  });

  it("maps worker to workerType and expands count without a legacy query", async () => {
    await api.createExperiment({
      metadata: { name: "Manual" },
      taxonomyRevisionId: "taxonomy-revision",
      request: {
        scenario: { task: "Build it", criteria: [] },
        worker: "coder-acp-copilot",
        model: "gpt-6.1-sol",
        count: 2,
      },
    });

    expect(apiClientMock).toHaveBeenCalledWith(
      "/api/v1/experiments?projectId=project-1",
      expect.objectContaining({ method: "POST" }),
    );
    expect(postedBody()).toEqual({
      mode: "compose",
      metadata: { name: "Manual" },
      requests: [
        {
          scenario: { task: "Build it", criteria: [] },
          workerType: "coder-acp-copilot",
          model: "gpt-6.1-sol",
        },
        {
          scenario: { task: "Build it", criteria: [] },
          workerType: "coder-acp-copilot",
          model: "gpt-6.1-sol",
        },
      ],
      reportTemplateIds: [],
      taxonomyRevisionId: "taxonomy-revision",
    });
  });

  it("expands profile variations with each resolved worker/model target", async () => {
    await api.createExperiment({
      metadata: { name: "Profiles" },
      request: {
        scenario: { task: "Compare", criteria: [] },
        profileId: "base@2",
        profileVariations: ["variation@3"],
        count: 2,
        experimentProfileTargets: [
          {
            profileId: "base@2",
            worker: "coder-acp-copilot",
            model: "gpt-6.1-sol",
            agentVersion: "copilot-dev",
          },
          {
            profileId: "variation@3",
            worker: "coder-acp-claude-code",
            model: "claude-sonnet-5.5",
          },
        ],
      },
    });

    expect(postedBody().requests).toEqual([
      expect.objectContaining({
        profileId: "base@2",
        workerType: "coder-acp-copilot",
        model: "gpt-6.1-sol",
        agentVersion: "copilot-dev",
      }),
      expect.objectContaining({
        profileId: "base@2",
        workerType: "coder-acp-copilot",
        model: "gpt-6.1-sol",
        agentVersion: "copilot-dev",
      }),
      expect.objectContaining({
        profileId: "variation@3",
        workerType: "coder-acp-claude-code",
        model: "claude-sonnet-5.5",
      }),
      expect.objectContaining({
        profileId: "variation@3",
        workerType: "coder-acp-claude-code",
        model: "claude-sonnet-5.5",
      }),
    ]);
    expect(JSON.stringify(postedBody())).not.toContain("profileVariations");
    expect(JSON.stringify(postedBody())).not.toContain('"worker":');
  });

  it("sends an explicit empty Experiment without requests", async () => {
    await api.createExperiment({
      metadata: { name: "Reserved" },
      reportTemplateIds: ["template-1"],
      empty: true,
    });

    expect(postedBody()).toEqual({
      mode: "empty",
      metadata: { name: "Reserved" },
      requests: [],
      reportTemplateIds: ["template-1"],
    });
  });

  it("preserves legacy run submission query composition separately", async () => {
    apiClientMock.mockResolvedValue(new Response(JSON.stringify({ id: "run-1" })));
    await api.submitRun({
      scenario: { task: "Build it", criteria: [] },
      worker: "coder-acp-copilot",
      model: "gpt-6.1-sol",
    });

    expect(apiClientMock).toHaveBeenCalledWith(
      "/api/v1/requests?worker=coder-acp-copilot&projectId=project-1",
      expect.objectContaining({
        body: JSON.stringify({
          scenario: { task: "Build it", criteria: [] },
          model: "gpt-6.1-sol",
        }),
      }),
    );
  });
});
