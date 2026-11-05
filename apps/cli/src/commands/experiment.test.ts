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

const lifecycle = {
  operationId: "operation-1",
  phase: "deleting",
  stateVersion: 2,
  progress: {
    expectedRequests: 1,
    completedRequests: 0,
    expectedReports: 1,
    completedReports: 0,
  },
  blocking: [],
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
        requestIds: [],
        reportTemplateIds: [],
      }),
    });
    expect(requests[0]?.url).toBe(
      "http://localhost:3100/api/v1/experiments?projectId=project-1",
    );
  });

  it("creates an experiment from existing standalone requests", async () => {
      const { requests } = mockFetchWith({
        experiment: {
          ...experiment,
          revision: { ...experiment.revision, memberCount: 2 },
        },
        requestIds: ["request-1", "request-2"],
      });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await makeProgram().parseAsync(
        [
          "experiment",
          "create",
          "--name",
          "Existing",
          "--request-id",
          "request-1",
          "--request-id",
          "request-2",
          "--project",
          "project-1",
          "--url",
          "http://localhost:3100",
        ],
        { from: "user" },
      );

      expect(requests[0]).toMatchObject({
        method: "POST",
        body: JSON.stringify({
          mode: "existing",
          metadata: { name: "Existing" },
          requests: [],
          requestIds: ["request-1", "request-2"],
          reportTemplateIds: [],
        }),
      });
  });

  it.each([
    ["add", "POST"],
    ["remove", "DELETE"],
  ])(
    "%s sends one complete membership revision request",
    async (command, method) => {
        const { requests } = mockFetchWith({
          experiment: {
            ...experiment,
            revision: {
              ...experiment.revision,
              experimentRevisionId: "revision-2",
              revisionNumber: 2,
            },
          },
          attachedRequestIds: command === "add" ? ["request-1", "request-2"] : [],
          detachedRequestIds:
            command === "remove" ? ["request-1", "request-2"] : [],
        });
        vi.spyOn(console, "log").mockImplementation(() => {});

        await makeProgram().parseAsync(
          [
            "experiment",
            command,
            "experiment-1",
            "--revision",
            "revision-1",
            "--request-id",
            "request-1",
            "--request-id",
            "request-2",
            "--project",
            "project-1",
            "--url",
            "http://localhost:3100",
          ],
          { from: "user" },
        );

        expect(requests[0]).toMatchObject({
          method,
          body: JSON.stringify({
            expectedExperimentRevisionId: "revision-1",
            requestIds: ["request-1", "request-2"],
          }),
        });
        expect(requests[0]?.url).toBe(
          "http://localhost:3100/api/v1/experiments/experiment-1/requests?projectId=project-1",
        );
    },
  );

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

  it("starts deletion without polling when --no-wait is set", async () => {
    const { requests } = mockFetchWith(lifecycle);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      output.push(parts.map(String).join(" "));
    });

    await makeProgram().parseAsync(
      [
        "experiment",
        "delete",
        "experiment-1",
        "--no-wait",
        "--output",
        "json",
        "--project",
        "project-1",
        "--url",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(requests).toEqual([
      expect.objectContaining({
        method: "DELETE",
        url: "http://localhost:3100/api/v1/experiments/experiment-1?projectId=project-1",
      }),
    ]);
    expect(output.join("\n")).toContain('"phase": "deleting"');
  });

  it("polls restore until the lifecycle reaches restored", async () => {
    vi.useFakeTimers();
    const requests: CapturedRequest[] = [];
    const responses = [
      { ...lifecycle, phase: "restoring" },
      {
        ...lifecycle,
        phase: "restored",
        stateVersion: 3,
        progress: {
          ...lifecycle.progress,
          completedRequests: 1,
          completedReports: 1,
        },
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push({
        url: request.url,
        method: request.method,
        body: await request.text(),
      });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    const command = makeProgram().parseAsync(
      [
        "experiment",
        "restore",
        "experiment-1",
        "--project",
        "project-1",
        "--url",
        "http://localhost:3100",
      ],
      { from: "user" },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await command;
    vi.useRealTimers();

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: "POST",
        url: "http://localhost:3100/api/v1/experiments/experiment-1/restore?projectId=project-1",
      },
      {
        method: "GET",
        url: "http://localhost:3100/api/v1/experiments/experiment-1/lifecycle?projectId=project-1",
      },
    ]);
  });

  it("surfaces lifecycle blockers without polling", async () => {
    const { requests } = mockFetchWith({
      ...lifecycle,
      blocking: [{
        kind: "request",
        id: "request-1",
        reason: "missing",
      }],
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await makeProgram().parseAsync(
      [
        "experiment",
        "delete",
        "experiment-1",
        "--project",
        "project-1",
        "--url",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(requests).toHaveLength(1);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "request:request-1 missing",
    );
    expect(process.exitCode).toBe(1);
  });

  it("retrieves structured JSON for one exact experiment execution", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push({
        url: request.url,
        method: request.method,
        body: await request.text(),
      });
      const structured = request.url.endsWith(
        "/structured?projectId=project-1",
      );
      return new Response(JSON.stringify(
        structured
          ? { meta: { experimentExecutionId: "execution-1" } }
          : [{
              id: "report-1",
              experimentId: "experiment-1",
              experimentExecutionId: "execution-1",
              status: "completed",
              createdAt: "2026-01-01T00:00:00.000Z",
            }],
      ), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      output.push(parts.map(String).join(" "));
    });

    await makeProgram().parseAsync(
      [
        "experiment",
        "reports",
        "experiment-1",
        "execution-1",
        "--report",
        "report-1",
        "--structured",
        "--project",
        "project-1",
        "--url",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(requests.map((item) => item.url)).toEqual([
      "http://localhost:3100/api/v1/experiments/experiment-1/executions/execution-1/reports?projectId=project-1",
      "http://localhost:3100/api/v1/experiments/experiment-1/executions/execution-1/reports/report-1/structured?projectId=project-1",
    ]);
    expect(output.join("\n")).toContain(
      '"experimentExecutionId": "execution-1"',
    );
  });
});
