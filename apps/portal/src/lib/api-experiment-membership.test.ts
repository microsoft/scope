// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { setSelectedProjectIdHolder } from "./project-scope";

const apiClientMock = vi.hoisted(() => vi.fn());

vi.mock("./api-client", () => ({
  apiClient: apiClientMock,
}));

const experiment = {
  experimentId: "experiment-1",
  projectId: "project-1",
  metadata: { name: "Existing runs" },
  revision: {
    experimentRevisionId: "revision-2",
    revisionNumber: 2,
    memberCount: 2,
  },
  execution: {
    experimentExecutionId: "execution-2",
    attemptNumber: 1,
    requests: [],
    handlerProgress: {},
    blocking: [],
    createdAt: "2026-10-16T00:00:00.000Z",
  },
  blocking: [],
  createdRequestIds: [],
  createdAt: "2026-10-16T00:00:00.000Z",
};

describe("Experiment membership API", () => {
  beforeEach(() => {
    apiClientMock.mockReset();
    setSelectedProjectIdHolder("project-1");
  });

  afterEach(() => {
    setSelectedProjectIdHolder(undefined);
  });

  it("creates an Experiment from existing request ids", async () => {
    apiClientMock.mockResolvedValue(
      new Response(JSON.stringify({ experiment, requestIds: ["request-1", "request-2"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await api.createExperimentFromRuns({
      metadata: { name: "Existing runs" },
      requestIds: ["request-1", "request-2"],
    });

    expect(result.experiment.revision.revisionNumber).toBe(2);
    expect(apiClientMock).toHaveBeenCalledWith(
      "/api/v1/experiments?projectId=project-1",
      expect.objectContaining({ method: "POST" }),
    );
    const init = apiClientMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      mode: "existing",
      metadata: { name: "Existing runs" },
      requests: [],
      requestIds: ["request-1", "request-2"],
      reportTemplateIds: [],
    });
  });

  it("sends one revision-guarded removal request and parses its result", async () => {
    apiClientMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          experiment,
          attachedRequestIds: [],
          detachedRequestIds: ["request-1"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await api.updateExperimentRequests("DELETE", "experiment-1", {
      expectedExperimentRevisionId: "revision-1",
      requestIds: ["request-1"],
    });

    expect(result.detachedRequestIds).toEqual(["request-1"]);
    expect(apiClientMock).toHaveBeenCalledWith(
      "/api/v1/experiments/experiment-1/requests?projectId=project-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    const init = apiClientMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      expectedExperimentRevisionId: "revision-1",
      requestIds: ["request-1"],
    });
  });
});
