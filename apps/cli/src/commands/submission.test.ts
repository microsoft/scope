// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSubmissionCommands } from "./submission.js";

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function makeProgram(): Command {
  const program = new Command();
  registerSubmissionCommands(program);
  return program;
}

function response(body: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe("submission report", () => {
  it("lists current and historical reports through the plural resource", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      urls.push(request.url);
      return response([
        {
          id: "report-current",
          submissionRunId: "submission-run-2",
          status: "completed",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "report-historical",
          submissionRunId: "submission-run-1",
          status: "failed",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
    }));
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      output.push(parts.map(String).join(" "));
    });

    await makeProgram().parseAsync(
      [
        "submission",
        "reports",
        "submission-1",
        "-u",
        "http://localhost:3100",
        "-o",
        "json",
      ],
      { from: "user" },
    );

    expect(urls).toEqual([
      "http://localhost:3100/api/v1/submissions/submission-1/reports",
    ]);
    expect(output.join("\n")).toContain('"id": "report-current"');
    expect(output.join("\n")).toContain('"id": "report-historical"');
  });
});
