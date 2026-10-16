// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { configureHelp } from "../utils/helpFormatter.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";
import {
  getDefaultApiUrl,
  withOutputOption,
  withProjectOption,
} from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch } from "../utils/api-client.js";
import { errorText, label, successText, value } from "../utils/style.js";

interface SubmissionSummary {
  submissionId: string;
  submissionRunId: string;
  attemptNumber: number;
  readiness: string;
  createdAt: string;
  requestIds: string[];
  requests: Array<{
    requestId: string;
    runId: string;
    task: string;
    status: string;
    outcome?: string;
  }>;
  blocking: Array<{
    requestId: string;
    runId: string;
    reason: string;
  }>;
}
async function responseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function throwApiError(response: Response): Promise<never> {
  const body = await responseJson<{ error?: string }>(response);
  throw new Error(body.error ?? `HTTP ${response.status}`);
}

const fields: DisplayField[] = [
  { key: "submissionId", label: "Submission" },
  { key: "attemptNumber", label: "Attempt" },
  { key: "readiness", label: "Readiness" },
  {
    key: "requestIds",
    label: "Runs",
    formatter: (row: Record<string, unknown>) =>
      String((row.requestIds as string[] | undefined)?.length ?? 0),
  },
  { key: "createdAt", label: "Created" },
];

export function registerSubmissionCommands(program: Command): void {
  const submission = program
    .command("submission")
    .description("Inspect and retry grouped run submissions")
    .action(() => submission.help());
  configureHelp(submission);

  withProjectOption(
    withOutputOption(
      submission
        .command("list")
        .description("List submissions")
        .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
    ),
  ).action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, "/submissions", { projectId });
      if (!response.ok) await throwApiError(response);
      const body = await responseJson<{ submissions: SubmissionSummary[] }>(response);
      console.log(
        formatData(body.submissions, fields, (options.output ?? "table") as OutputFormat),
      );
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

  withOutputOption(
    submission
      .command("get")
      .description("Get a submission and its current request/run vector")
      .argument("<id>", "Submission ID")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (id: string, options) => {
    try {
      const response = await apiFetch(
        options.url,
        `/submissions/${encodeURIComponent(id)}`,
      );
      if (!response.ok) await throwApiError(response);
      const doc = await responseJson<SubmissionSummary>(response);
      const format = (options.output ?? "table") as OutputFormat;
      if (isMachineReadable(format)) {
        console.log(formatData([doc], fields, format));
        return;
      }
      console.log(`${label("Submission:")} ${value(doc.submissionId)}`);
      console.log(`${label("Attempt:")} ${value(String(doc.attemptNumber))}`);
      console.log(`${label("Readiness:")} ${value(doc.readiness)}`);
      console.log(`${label("Submission run:")} ${value(doc.submissionRunId)}`);
      for (const request of doc.requests) {
        console.log(
          `  ${value(request.requestId)} ${request.status}` +
            `${request.outcome ? `/${request.outcome}` : ""} run=${request.runId}`,
        );
      }
      for (const blocking of doc.blocking) {
        console.log(
          `  blocked ${blocking.requestId}/${blocking.runId}: ${blocking.reason}`,
        );
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

  withOutputOption(
    submission
      .command("runs")
      .description("List current and archived submission attempts")
      .argument("<id>", "Submission ID")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (id: string, options) => {
    try {
      const response = await apiFetch(
        options.url,
        `/submissions/${encodeURIComponent(id)}/runs`,
      );
      if (!response.ok) await throwApiError(response);
      const body = await responseJson<{
        runs: Array<{
          _id: string;
          attemptNumber: number;
          createdAt: string;
          requests: unknown[];
          supersededReason?: string;
        }>;
      }>(response);
      const runFields: DisplayField[] = [
        { key: "_id", label: "Submission Run" },
        { key: "attemptNumber", label: "Attempt" },
        {
          key: "requests",
          label: "Runs",
          formatter: (row: Record<string, unknown>) =>
            String((row.requests as unknown[] | undefined)?.length ?? 0),
        },
        { key: "supersededReason", label: "Superseded" },
        { key: "createdAt", label: "Created" },
      ];
      console.log(
        formatData(body.runs, runFields, (options.output ?? "table") as OutputFormat),
      );
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

  submission
    .command("retry")
    .description("Retry the current submission processing attempt")
    .argument("<id>", "Submission ID")
    .requiredOption("--submission-run <id>", "Current submission run ID")
    .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
    .action(async (id: string, options) => {
      try {
        const response = await apiFetch(
          options.url,
          `/submissions/${encodeURIComponent(id)}/retry`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ submissionRunId: options.submissionRun }),
          },
        );
        if (!response.ok) await throwApiError(response);
        const result = await responseJson<{
          submissionRunId: string;
          attemptNumber: number;
          readiness: string;
        }>(response);
        console.log(
          successText(
            `Submission retry started: attempt ${result.attemptNumber} (${result.submissionRunId}, ${result.readiness})`,
          ),
        );
      } catch (error) {
        console.error(errorText("Error:"), error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    });
}
