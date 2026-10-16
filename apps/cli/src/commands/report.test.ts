// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerReportCommands } from "./report.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe("report get", () => {
  it("downloads Structured JSON through the standard report-by-ID command", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      urls.push(request.url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          meta: { schemaId: "scope.submission-readout" },
        }),
      };
    }));
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      output.push(parts.map(String).join(" "));
    });
    const program = new Command();
    registerReportCommands(program);

    await program.parseAsync(
      [
        "report",
        "get",
        "-i",
        "report-1",
        "--structured",
        "-u",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(urls).toEqual([
      "http://localhost:3100/api/v1/reports/report-1/structured",
    ]);
    expect(output.join("\n")).toContain('"schemaId": "scope.submission-readout"');
  });

  it("renders submission subject metadata through standard report retrieval", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "report-1",
        submissionId: "submission-1",
        submissionRunId: "submission-run-1",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    })));
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      output.push(parts.map(String).join(" "));
    });
    const program = new Command();
    registerReportCommands(program);

    await program.parseAsync(
      [
        "report",
        "get",
        "-i",
        "report-1",
        "-o",
        "json",
        "-u",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(output.join("\n")).toContain('"submissionId": "submission-1"');
    expect(output.join("\n")).toContain(
      '"submissionRunId": "submission-run-1"',
    );
  });
});

describe("report list", () => {
  it("passes submission filters to the global reports collection", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      urls.push(request.url);
      return {
        ok: true,
        status: 200,
        json: async () => [],
      };
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = new Command();
    registerReportCommands(program);

    await program.parseAsync(
      [
        "report",
        "list",
        "--submission",
        "submission-1",
        "--submission-run",
        "submission-run-1",
        "--project",
        "project-1",
        "-o",
        "json",
        "-u",
        "http://localhost:3100",
      ],
      { from: "user" },
    );

    expect(urls).toEqual([
      "http://localhost:3100/api/v1/reports?submissionId=submission-1&submissionRunId=submission-run-1&projectId=project-1",
    ]);
  });
});
