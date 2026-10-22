// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerExperimentCommands } from "./experiment.js";

interface CapturedRequest {
  url: string;
  method: string;
  body: string;
}

const experiment = {
  experimentId: "experiment-1",
  projectId: "project-1",
  metadata: { name: "Experiment 1" },
  revision: {
    experimentRevisionId: "revision-1",
    revisionNumber: 1,
    memberCount: 0,
  },
  execution: {
    experimentExecutionId: "execution-1",
    attemptNumber: 1,
    readiness: "ready",
    requests: [],
    handlerProgress: {},
    blocking: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  readiness: "ready",
  blocking: [],
  createdRequestIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeProgram(): Command {
  const program = new Command();
  registerExperimentCommands(program);
  return program;
}

function mockFetchWith(
  body: unknown,
): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push({
        url: request.url,
        method: request.method,
        body: await request.text(),
      });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return { requests };
}

describe("experiment commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("does not expose removed Experiment tags", () => {
    const experimentCommand = makeProgram().commands.find(
      (command) => command.name() === "experiment",
    );
    const createCommand = experimentCommand?.commands.find(
      (command) => command.name() === "create",
    );

    expect(createCommand).toBeDefined();
    expect(createCommand?.options.map((option) => option.long)).not.toContain(
      "--tags",
    );
  });

  it("previews composition without calling the API or warning", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await makeProgram().parseAsync(
      [
        "experiment",
        "create",
        "--name",
        "Nightly",
        "--message",
        "Run tests",
        "--count",
        "2",
        "--preview",
        "--output",
        "json",
        "--project",
        "project-1",
        "--url",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain('"expandedRunCount": 2');
    expect(log.mock.calls.flat().join("\n")).toContain('"count": 2');
  });

  it("creates an explicitly empty project-scoped experiment", async () => {
    const { requests } = mockFetchWith({
      experiment,
      requestIds: [],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await makeProgram().parseAsync(
      [
        "experiment",
        "create",
        "--name",
        "Empty",
        "--empty",
        "--project",
        "project-1",
        "--url",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        mode: "empty",
        metadata: { name: "Empty" },
        requests: [],
      }),
    });
    expect(requests[0]?.url).toBe(
      "http://localhost:3100/api/v1/experiments?projectId=project-1",
    );
  });

  it("gets an exact project-scoped execution", async () => {
    const { requests } = mockFetchWith(experiment.execution);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await makeProgram().parseAsync(
      [
        "experiment",
        "executions",
        "experiment-1",
        "execution-1",
        "--project",
        "project-1",
        "--url",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(requests[0]?.url).toBe(
      "http://localhost:3100/api/v1/experiments/experiment-1/executions/execution-1?projectId=project-1",
    );
  });

  it("retries with the current execution identifier", async () => {
    const { requests } = mockFetchWith({
      experimentId: "experiment-1",
      experimentExecutionId: "execution-2",
      attemptNumber: 2,
      readiness: "ready",
      blockers: [],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await makeProgram().parseAsync(
      [
        "experiment",
        "retry",
        "experiment-1",
        "--execution",
        "execution-1",
        "--project",
        "project-1",
        "--url",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(requests[0]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ experimentExecutionId: "execution-1" }),
    });
    expect(requests[0]?.url).toBe(
      "http://localhost:3100/api/v1/experiments/experiment-1/retry?projectId=project-1",
    );
  });
});
