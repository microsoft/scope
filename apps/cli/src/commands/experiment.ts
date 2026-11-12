// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import EventSource from "eventsource";
import { stringify as stringifyYaml } from "yaml";
import { resolveScenarioAndPersona } from "../config-loader.js";
import { apiFetch, getApiBasePath } from "../utils/api-client.js";
import { requireProjectId } from "../utils/config.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import { parseGatesOption } from "../utils/gates.js";
import { configureHelp } from "../utils/helpFormatter.js";
import { buildResourceBindingSpecs, collectRepeatable } from "../utils/resources.js";
import {
  getDefaultApiUrl,
  normalizeUrl,
  withOutputOption,
  withProjectOption,
} from "../utils/shared.js";
import { errorText, label, successText, value } from "../utils/style.js";
import type { DisplayField, OutputFormat } from "../utils/types.js";

interface ExperimentMetadata {
  name: string;
  description?: string;
}

interface ExperimentLifecycle {
  operationId: string;
  phase: "deleting" | "deleted" | "restoring" | "restored";
  stateVersion: number;
  progress: {
    expectedRequests: number;
    completedRequests: number;
    expectedReports: number;
    completedReports: number;
  };
  blocking: Array<{
    kind: "request" | "report" | "experiment";
    id: string;
    reason: string;
    error?: string;
  }>;
}

interface ExperimentExecution {
  experimentExecutionId: string;
  attemptNumber: number;
  version?: number;
  readiness?: string;
  requestCount: number;
  requests: ExperimentRequestSummary[];
  handlerProgress: JsonRecord;
  reportTemplates: JsonRecord;
  blocking: ExperimentBlocker[];
  report?: {
    reportId: string;
    url: string;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  discardedAt?: string;
  discardReason?: string;
  supersededAt?: string;
  supersededByExperimentExecutionId?: string;
  supersededReason?: "rollover" | "retry" | "membership" | "templates";
  archivedAt?: string;
}

interface ExperimentBlocker {
  handlerId: string;
  reason: string;
  requestId?: string;
  runId?: string;
  error?: string;
}

interface ExperimentRequestSummary {
  requestId: string;
  runId: string;
  task?: string;
  status?: string;
  outcome?: string;
  workerType?: string;
  model?: string;
  profileId?: string;
}

interface ExperimentView {
  experimentId: string;
  projectId: string;
  metadata: ExperimentMetadata;
  revision: {
    experimentRevisionId: string;
    revisionNumber: number;
    memberCount: number;
    reportTemplateIds: string[];
    membershipFingerprint?: string;
    definitionFingerprint?: string;
    createdAt?: string;
  };
  execution: ExperimentExecution;
  readiness?: string;
  blocking: ExperimentBlocker[];
  createdRequestIds: string[];
  createdAt: string;
  updatedAt?: string;
  finalizedAt?: string;
  deletedAt?: string;
  lifecycle?: ExperimentLifecycle;
}

interface ExperimentPage {
  items: ExperimentView[];
  nextCursor?: string;
}

interface ExperimentExecutionPage {
  items: ExperimentExecution[];
  nextCursor?: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name} response from Scope`);
  }
  return value as JsonRecord;
}

function stringField(
  value: JsonRecord,
  key: string,
  name: string,
  optional = false,
): string | undefined {
  const field = value[key];
  if (field === undefined && optional) return undefined;
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid ${name}.${key} response from Scope`);
  }
  return field;
}

function numberField(value: JsonRecord, key: string, name: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Invalid ${name}.${key} response from Scope`);
  }
  return field;
}

function parseBlocker(value: unknown): ExperimentBlocker {
  const blocker = asRecord(value, "experiment blocker");
  return {
    handlerId: stringField(blocker, "handlerId", "experiment blocker")!,
    reason: stringField(blocker, "reason", "experiment blocker")!,
    requestId: stringField(blocker, "requestId", "experiment blocker", true),
    runId: stringField(blocker, "runId", "experiment blocker", true),
    error: stringField(blocker, "error", "experiment blocker", true),
  };
}

function parseRequestSummary(value: unknown): ExperimentRequestSummary {
  const request = asRecord(value, "experiment request");
  return {
    requestId: stringField(request, "requestId", "experiment request")!,
    runId: stringField(request, "runId", "experiment request")!,
    task: stringField(request, "task", "experiment request", true),
    status: stringField(request, "status", "experiment request", true),
    outcome: stringField(request, "outcome", "experiment request", true),
    workerType: stringField(request, "workerType", "experiment request", true),
    model: stringField(request, "model", "experiment request", true),
    profileId: stringField(request, "profileId", "experiment request", true),
  };
}

function parseExecution(value: unknown): ExperimentExecution {
  const execution = asRecord(value, "experiment execution");
  const requests = execution.requests;
  const requestVector = Array.isArray(requests)
    ? { requestCount: requests.length, requests: requests.map(parseRequestSummary) }
    : (() => {
        const payload = requests === undefined
          ? {}
          : asRecord(requests, "experiment requests");
        const entries = Array.isArray(payload.entries)
          ? payload.entries.map(parseRequestSummary)
          : [];
        return {
          requestCount:
            typeof payload.entryCount === "number"
              ? payload.entryCount
              : entries.length,
          requests: entries,
        };
      })();
  const blockingValue = execution.blockers ?? execution.blocking;
  const blocking = Array.isArray(blockingValue)
    ? blockingValue.map(parseBlocker)
    : [];
  const progress = asRecord(
    execution.progress ??
      execution.handlerProgress ??
      execution.handlerSummary ??
      {},
    "experiment handler progress",
  );
  const report = execution.report === undefined
    ? undefined
    : asRecord(execution.report, "experiment report");
  return {
    experimentExecutionId: stringField(
      execution,
      "experimentExecutionId",
      "experiment execution",
    )!,
    attemptNumber: numberField(
      execution,
      "attemptNumber",
      "experiment execution",
    ),
    readiness: stringField(
      execution,
      "readiness",
      "experiment execution",
      true,
    ),
    version:
      typeof execution.version === "number" ? execution.version : undefined,
    requestCount: requestVector.requestCount,
    requests: requestVector.requests,
    handlerProgress: progress,
    reportTemplates: asRecord(
      execution.reportTemplates ?? {},
      "experiment report templates",
    ),
    blocking,
    report: report
      ? {
          reportId: stringField(report, "reportId", "experiment report")!,
          url: stringField(report, "url", "experiment report")!,
          updatedAt: stringField(report, "updatedAt", "experiment report")!,
        }
      : undefined,
    createdAt: stringField(
      execution,
      "createdAt",
      "experiment execution",
    )!,
    updatedAt: stringField(execution, "updatedAt", "experiment execution", true),
    startedAt: stringField(execution, "startedAt", "experiment execution", true),
    finishedAt: stringField(execution, "finishedAt", "experiment execution", true),
    discardedAt: stringField(execution, "discardedAt", "experiment execution", true),
    discardReason: stringField(execution, "discardReason", "experiment execution", true),
    supersededAt: stringField(execution, "supersededAt", "experiment execution", true),
    supersededByExperimentExecutionId: stringField(
      execution,
      "supersededByExperimentExecutionId",
      "experiment execution",
      true,
    ),
    supersededReason:
      execution.supersededReason === "rollover" ||
      execution.supersededReason === "retry" ||
      execution.supersededReason === "membership" ||
      execution.supersededReason === "templates"
        ? execution.supersededReason
        : undefined,
    archivedAt: stringField(execution, "archivedAt", "experiment execution", true),
  };
}

function parseExperiment(value: unknown): ExperimentView {
  const experiment = asRecord(value, "experiment");
  const metadata = asRecord(experiment.metadata, "experiment metadata");
  const revision = asRecord(experiment.revision, "experiment revision");
  const execution = parseExecution(
    experiment.execution ?? experiment.currentExecution,
  );
  const blockingValue = experiment.blocking ?? execution.blocking;
  const blocking = Array.isArray(blockingValue)
    ? blockingValue.map(parseBlocker)
    : [];
  const createdRequestIds = Array.isArray(experiment.createdRequestIds)
    ? experiment.createdRequestIds.map((id) => {
        if (typeof id !== "string") {
          throw new Error("Invalid experiment.createdRequestIds response from Scope");
        }
        return id;
      })
    : [];
  return {
    experimentId: stringField(experiment, "experimentId", "experiment")!,
    projectId: stringField(experiment, "projectId", "experiment")!,
    metadata: {
      name: stringField(metadata, "name", "experiment metadata")!,
      description: stringField(
        metadata,
        "description",
        "experiment metadata",
        true,
      ),
    },
    revision: {
      experimentRevisionId: stringField(
        revision,
        "experimentRevisionId",
        "experiment revision",
      )!,
      revisionNumber: numberField(
        revision,
        "revisionNumber",
        "experiment revision",
      ),
      memberCount:
        typeof revision.memberCount === "number"
          ? revision.memberCount
          : execution.requestCount,
      reportTemplateIds: Array.isArray(revision.reportTemplateIds)
        ? revision.reportTemplateIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
      membershipFingerprint: stringField(
        revision,
        "membershipFingerprint",
        "experiment revision",
        true,
      ),
      definitionFingerprint: stringField(
        revision,
        "definitionFingerprint",
        "experiment revision",
        true,
      ),
      createdAt: stringField(revision, "createdAt", "experiment revision", true),
    },
    execution,
    readiness:
      stringField(experiment, "readiness", "experiment", true) ??
      execution.readiness,
    blocking,
    createdRequestIds,
    createdAt: stringField(experiment, "createdAt", "experiment")!,
    updatedAt: stringField(experiment, "updatedAt", "experiment", true),
    finalizedAt: stringField(experiment, "finalizedAt", "experiment", true),
    deletedAt: stringField(experiment, "deletedAt", "experiment", true),
    lifecycle:
      experiment.lifecycle === undefined
        ? undefined
        : parseLifecycle(experiment.lifecycle),
  };
}

function parseLifecycle(value: unknown): ExperimentLifecycle {
  const lifecycle = asRecord(value, "experiment lifecycle");
  const progress = asRecord(
    lifecycle.progress,
    "experiment lifecycle progress",
  );
  const phase = stringField(lifecycle, "phase", "experiment lifecycle")!;
  if (
    phase !== "deleting" &&
    phase !== "deleted" &&
    phase !== "restoring" &&
    phase !== "restored"
  ) {
    throw new Error("Invalid experiment lifecycle.phase response from Scope");
  }
  const blocking = lifecycle.blocking;
  if (!Array.isArray(blocking)) {
    throw new Error("Invalid experiment lifecycle.blocking response from Scope");
  }
  return {
    operationId: stringField(
      lifecycle,
      "operationId",
      "experiment lifecycle",
    )!,
    phase,
    stateVersion: numberField(
      lifecycle,
      "stateVersion",
      "experiment lifecycle",
    ),
    progress: {
      expectedRequests: numberField(
        progress,
        "expectedRequests",
        "experiment lifecycle progress",
      ),
      completedRequests: numberField(
        progress,
        "completedRequests",
        "experiment lifecycle progress",
      ),
      expectedReports: numberField(
        progress,
        "expectedReports",
        "experiment lifecycle progress",
      ),
      completedReports: numberField(
        progress,
        "completedReports",
        "experiment lifecycle progress",
      ),
    },
    blocking: blocking.map((item) => {
      const blocker = asRecord(item, "experiment lifecycle blocker");
      const kind = stringField(
        blocker,
        "kind",
        "experiment lifecycle blocker",
      );
      if (kind !== "request" && kind !== "report" && kind !== "experiment") {
        throw new Error("Invalid experiment lifecycle blocker kind");
      }
      return {
        kind,
        id: stringField(blocker, "id", "experiment lifecycle blocker")!,
        reason: stringField(
          blocker,
          "reason",
          "experiment lifecycle blocker",
        )!,
        error: stringField(
          blocker,
          "error",
          "experiment lifecycle blocker",
          true,
        ),
      };
    }),
  };
}

function parsePage(value: unknown): ExperimentPage {
  const page = asRecord(value, "experiment page");
  const items = page.data ?? page.items;
  if (!Array.isArray(items)) {
    throw new Error("Invalid experiment page items response from Scope");
  }
  return {
    items: items.map(parseExperiment),
    nextCursor: stringField(page, "nextCursor", "experiment page", true),
  };
}

function parseExecutionPage(value: unknown): ExperimentExecutionPage {
  const page = asRecord(value, "experiment execution page");
  const items = page.data ?? page.items;
  if (!Array.isArray(items)) {
    throw new Error("Invalid experiment execution page items response from Scope");
  }
  return {
    items: items.map(parseExecution),
    nextCursor: stringField(
      page,
      "nextCursor",
      "experiment execution page",
      true,
    ),
  };
}

async function json(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

async function throwApiError(response: Response): Promise<never> {
  const value = await json(response);
  const body = asRecord(value, "error");
  throw new Error(
    typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
  );
}

function resolveTextOrFile(input: string): string {
  return input.startsWith("@")
    ? readFileSync(resolve(input.slice(1)), "utf8")
    : input;
}

const fields: DisplayField[] = [
  { key: "experimentId", label: "Experiment" },
  {
    key: "metadata",
    label: "Name",
    formatter: (row: JsonRecord) =>
      String((row.metadata as ExperimentMetadata | undefined)?.name ?? ""),
  },
  {
    key: "execution",
    label: "Attempt",
    formatter: (row: JsonRecord) =>
      String((row.execution as ExperimentExecution | undefined)?.attemptNumber ?? ""),
  },
  { key: "readiness", label: "Readiness" },
  {
    key: "revision",
    label: "Runs",
    formatter: (row: JsonRecord) =>
      String(
        (row.revision as ExperimentView["revision"] | undefined)?.memberCount ?? 0,
      ),
  },
  { key: "createdAt", label: "Created" },
];

function addRunConfigurationOptions(command: Command): Command {
  return command
    .option("-s, --scenario <path>", "Scenario YAML file")
    .option("-p, --persona <path>", "Persona YAML file")
    .option("-t, --traits <path>", "Traits YAML file")
    .option("-m, --message <message>", "Task prompt")
    .option("-w, --worker <worker>", "Registered worker ID")
    .option("-c, --criteria <criteria...>", "Evaluation criteria")
    .option("--max-iterations <number>", "Max judge iterations", Number.parseInt)
    .option("--model <model>", "Coding-agent model")
    .option("--reasoning-effort <level>", "Reasoning effort")
    .option("--mcp-servers <slugs...>", "MCP server slugs")
    .option("--skills <slugs...>", "Skill slugs")
    .option("--codebase <ref>", "Codebase revision reference")
    .option("--resources <specs...>", "Resource binding specs")
    .option(
      "--resource-param <slug>:<KEY>=<VALUE>",
      "Resource parameter override (repeatable)",
      collectRepeatable,
      [],
    )
    .option("--extensions <ids...>", "VS Code extension IDs")
    .option("--agent-version <version>", "Agent version")
    .option("--profile <id>", "Base profile ID or version ref")
    .option(
      "--profile-variations-file <path>",
      "JSON file containing profile variation refs",
    )
    .option(
      "--agents-md <text|@file>",
      "AGENTS.md content; prefix a path with @",
    )
    .option("--gates <jsonOrFile>", "Gate configuration JSON or file")
    .option("--observations <ids...>", "Observation criterion IDs")
    .option(
      "--count <number>",
      "Occurrences per configuration (1-10)",
      (value: string) => Number.parseInt(value, 10),
    );
}

function buildRequest(options: Record<string, unknown>): {
  worker?: string;
  request: JsonRecord;
  profileCount: number;
  occurrences: number;
} {
  let message =
    typeof options.message === "string" ? options.message : undefined;
  let criteria = Array.isArray(options.criteria)
    ? options.criteria.filter((item): item is string => typeof item === "string")
    : undefined;
  let personaInstructions: string | undefined;
  let persona: Record<string, unknown> | undefined;
  if (typeof options.scenario === "string") {
    const resolved = resolveScenarioAndPersona(
      options.scenario,
      typeof options.persona === "string" ? options.persona : undefined,
      typeof options.traits === "string" ? options.traits : undefined,
    );
    message ??= resolved.task;
    if (!criteria?.length) criteria = resolved.criteria;
    personaInstructions = resolved.personaInstructions;
    persona = resolved.persona;
  }
  if (!message?.trim()) {
    throw new Error("--message or --scenario is required unless --empty is used");
  }

  const occurrences =
    typeof options.count === "number" ? options.count : 1;
  if (!Number.isInteger(occurrences) || occurrences < 1 || occurrences > 10) {
    throw new Error("--count must be an integer between 1 and 10");
  }

  const request: JsonRecord = {
    scenario: { task: message.trim(), criteria: criteria ?? [] },
  };
  const copyString = (source: string, target = source): void => {
    if (typeof options[source] === "string" && options[source]) {
      request[target] = options[source];
    }
  };
  copyString("model");
  copyString("reasoningEffort");
  copyString("agentVersion");
  copyString("profile", "profileId");
  copyString("codebase");
  if (typeof options.maxIterations === "number") {
    request.maxIterations = options.maxIterations;
  }
  if (personaInstructions) request.personaInstructions = personaInstructions;
  if (persona) request.persona = persona;
  if (occurrences > 1) request.count = occurrences;
  for (const [source, target] of [
    ["mcpServers", "mcpServers"],
    ["skills", "skills"],
    ["extensions", "extensions"],
    ["observations", "observations"],
  ] as const) {
    if (Array.isArray(options[source]) && options[source].length > 0) {
      request[target] = options[source];
    }
  }
  const resources = buildResourceBindingSpecs(
    Array.isArray(options.resources)
      ? options.resources.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined,
    Array.isArray(options.resourceParam)
      ? options.resourceParam.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  if (resources) request.resources = resources;
  if (typeof options.agentsMd === "string") {
    const content = resolveTextOrFile(options.agentsMd);
    if (content.trim()) request.agentsMd = content;
  }
  if (typeof options.gates === "string") {
    request.gates = parseGatesOption(
      options.gates,
      typeof options.maxIterations === "number"
        ? options.maxIterations
        : undefined,
    );
  }

  let profileCount = typeof options.profile === "string" ? 1 : 0;
  if (typeof options.profileVariationsFile === "string") {
    if (typeof options.profile !== "string") {
      throw new Error(
        "--profile is required with --profile-variations-file",
      );
    }
    const parsed: unknown = JSON.parse(
      readFileSync(resolve(options.profileVariationsFile), "utf8"),
    );
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("profile variations file must be a JSON string array");
    }
    request.profileVariations = parsed;
    profileCount += parsed.length;
  }
  if (profileCount === 0) profileCount = 1;

  return {
    worker: typeof options.worker === "string" ? options.worker : undefined,
    request,
    profileCount,
    occurrences,
  };
}

export function registerExperimentCommands(program: Command): void {
  const experiment = program
    .command("experiment")
    .description("Create and inspect benchmark experiments")
    .action(() => experiment.help());
  configureHelp(experiment);

  const create = addRunConfigurationOptions(
    withProjectOption(
      withOutputOption(
        experiment
          .command("create")
          .description("Create an experiment from a run configuration")
          .requiredOption("--name <name>", "Experiment name")
          .option("--description <text>", "Experiment description")
          .option(
            "--report-template <id>",
            "Select a manual Experiment report template (repeatable)",
            collectRepeatable,
            [],
          )
          .option("--empty", "Create an explicit empty experiment")
          .option(
            "--request-id <id>",
            "Create from an existing standalone request (repeatable)",
            collectRepeatable,
            [],
          )
          .option(
            "--preview",
            "Print the composition and request body without creating",
          )
          .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
      ),
    ),
  );

  create.action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const metadata: ExperimentMetadata = {
        name: options.name,
        ...(options.description ? { description: options.description } : {}),
      };
      if (options.empty) {
        const conflicting = [
          "scenario",
          "message",
          "worker",
          "criteria",
          "profile",
          "profileVariationsFile",
          "count",
        ].filter((key) => options[key] !== undefined);
        if (conflicting.length > 0) {
          throw new Error(
            `--empty cannot be combined with run configuration options: ${conflicting.join(", ")}`,
          );
        }
      }
      const requestIds = Array.isArray(options.requestId)
        ? options.requestId as string[]
        : [];
      if (options.empty && requestIds.length > 0) {
        throw new Error("--empty cannot be combined with --request-id");
      }
      if (requestIds.length > 0) {
        const conflicting = [
          "scenario",
          "message",
          "worker",
          "criteria",
          "profile",
          "profileVariationsFile",
          "count",
        ].filter((key) => options[key] !== undefined);
        if (conflicting.length > 0) {
          throw new Error(
            `--request-id cannot be combined with run configuration options: ${conflicting.join(", ")}`,
          );
        }
      }
      const built =
        options.empty || requestIds.length > 0
          ? undefined
          : buildRequest(options);
      const body = options.empty
        ? {
            mode: "empty" as const,
            metadata,
            requests: [],
            requestIds: [],
            reportTemplateIds: options.reportTemplate as string[],
          }
        : requestIds.length > 0
          ? {
              mode: "existing" as const,
              metadata,
              requests: [],
              requestIds,
              reportTemplateIds: options.reportTemplate as string[],
            }
          : {
            mode: "compose" as const,
            metadata,
            requests: [built!.request],
            requestIds: [],
            reportTemplateIds: options.reportTemplate as string[],
          };
      const expandedRunCount = built
        ? built.profileCount * built.occurrences
        : 0;
      if (options.preview) {
        const preview = {
          expandedRunCount,
          body,
        };
        const format = (options.output ?? "json") as OutputFormat;
        if (format === "json") {
          console.log(JSON.stringify(preview, null, 2));
          return;
        }
        if (format === "yaml") {
          console.log(stringifyYaml(preview).trimEnd());
          return;
        }
        console.log(
          formatData(
            [preview],
            [
              { key: "expandedRunCount", label: "Runs" },
              {
                key: "body",
                label: "Create body",
                formatter: () => JSON.stringify(body),
              },
            ],
            format,
          ),
        );
        return;
      }
      const workerQuery = built?.worker
        ? `?worker=${encodeURIComponent(built.worker)}`
        : "";
      const response = await apiFetch(
        options.url,
        `/experiments${workerQuery}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          projectId,
        },
      );
      if (!response.ok) await throwApiError(response);
      const createResponse = asRecord(await json(response), "experiment create");
      const created = parseExperiment(createResponse.experiment);
      const format = (options.output ?? "table") as OutputFormat;
      if (isMachineReadable(format)) {
        console.log(formatData([created], fields, format));
        return;
      }
      console.log(
        `${successText("Experiment created:")} ${value(created.experimentId)}`,
      );
      console.log(`${label("Name:")} ${value(created.metadata.name)}`);
      console.log(
        `${label("Runs:")} ${value(String(created.revision.memberCount))}`,
      );
      console.log(
        `${label("Execution:")} ${value(created.execution.experimentExecutionId)}`,
      );
    } catch (error) {
      console.error(
        errorText("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    }
  });

  const membershipAction = (
    command: Command,
    method: "POST" | "DELETE",
    verb: "added" | "removed",
  ) => {
    withProjectOption(
      command
        .argument("<id>", "Experiment ID")
        .requiredOption(
          "--revision <id>",
          "Expected current Experiment revision ID",
        )
        .requiredOption(
          "--request-id <id>",
          "Request ID (repeatable)",
          collectRepeatable,
          [],
        )
        .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
    ).action(async (id, options) => {
      try {
        const projectId = requireProjectId(options.project);
        const requestIds = options.requestId as string[];
        const response = await apiFetch(
          options.url,
          `/experiments/${encodeURIComponent(id)}/requests`,
          {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedExperimentRevisionId: options.revision,
              requestIds,
            }),
            projectId,
          },
        );
        if (!response.ok) await throwApiError(response);
        const result = asRecord(
          await json(response),
          `experiment membership ${verb}`,
        );
        const updated = parseExperiment(result.experiment);
        console.log(
          successText(
            `${requestIds.length} request${requestIds.length === 1 ? "" : "s"} ${verb}`,
          ),
        );
        console.log(
          `${label("Revision:")} ${value(updated.revision.experimentRevisionId)} (${value(`r${updated.revision.revisionNumber}`)})`,
        );
        console.log(
          `${label("Execution:")} ${value(updated.execution.experimentExecutionId)}`,
        );
      } catch (error) {
        console.error(
          errorText("Error:"),
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
      }
    });
  };

  membershipAction(
    experiment
      .command("add")
      .alias("move")
      .description("Move standalone requests into an Experiment"),
    "POST",
    "added",
  );
  membershipAction(
    experiment
      .command("remove")
      .description("Remove requests from an Experiment to standalone status"),
    "DELETE",
    "removed",
  );

  withProjectOption(
    experiment
      .command("report-templates")
      .description(
        "Replace manual report-template selection (creates a revision when changed)",
      )
      .argument("<id>", "Experiment ID")
      .requiredOption(
        "--revision <id>",
        "Expected current Experiment revision ID",
      )
      .option(
        "--template <id>",
        "Manual Experiment report template ID (repeatable; omit all to detach)",
        collectRepeatable,
        [],
      )
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (id: string, options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(
        options.url,
        `/experiments/${encodeURIComponent(id)}/report-templates`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedExperimentRevisionId: options.revision,
            reportTemplateIds: options.template as string[],
          }),
          projectId,
        },
      );
      if (!response.ok) await throwApiError(response);
      const updated = parseExperiment(await json(response));
      console.log(
        `${successText("Experiment report templates updated:")} ${value(
          updated.revision.reportTemplateIds.join(", ") || "none",
        )}`,
      );
      console.log(
        `${label("Revision:")} ${value(
          updated.revision.experimentRevisionId,
        )} (${value(`r${updated.revision.revisionNumber}`)})`,
      );
    } catch (error) {
      console.error(
        errorText("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    }
  });

  const lifecycleAction = (
    command: Command,
    method: "DELETE" | "POST",
    pathSuffix: "" | "/restore",
    terminalPhase: "deleted" | "restored",
  ) => {
    withProjectOption(
      withOutputOption(
        command
          .argument("<id>", "Experiment ID")
          .option("--no-wait", "Return after the lifecycle operation starts")
          .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
      ),
    ).action(async (id: string, options) => {
      try {
        const projectId = requireProjectId(options.project);
        const response = await apiFetch(
          options.url,
          `/experiments/${encodeURIComponent(id)}${pathSuffix}`,
          { method, projectId },
        );
        if (!response.ok) await throwApiError(response);
        let state = parseLifecycle(await json(response));
        while (options.wait !== false && state.phase !== terminalPhase) {
          if (state.blocking.length > 0) {
            throw new Error(
              `Experiment lifecycle blocked: ${state.blocking
                .map((blocker) =>
                  `${blocker.kind}:${blocker.id} ${blocker.reason}${
                    blocker.error ? ` (${blocker.error})` : ""
                  }`
                )
                .join(", ")}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const status = await apiFetch(
            options.url,
            `/experiments/${encodeURIComponent(id)}/lifecycle`,
            { projectId },
          );
          if (!status.ok) await throwApiError(status);
          state = parseLifecycle(await json(status));
        }
        const format = (options.output ?? "table") as OutputFormat;
        if (isMachineReadable(format)) {
          console.log(formatData([state], [
            { key: "operationId", label: "Operation" },
            { key: "phase", label: "Phase" },
            { key: "stateVersion", label: "Version" },
          ], format));
          return;
        }
        console.log(`${label("Operation:")} ${value(state.operationId)}`);
        console.log(`${label("Phase:")} ${value(state.phase)}`);
        console.log(
          `${label("Requests:")} ${value(
            `${state.progress.completedRequests}/${state.progress.expectedRequests}`,
          )}`,
        );
        console.log(
          `${label("Reports:")} ${value(
            `${state.progress.completedReports}/${state.progress.expectedReports}`,
          )}`,
        );
      } catch (error) {
        console.error(
          errorText("Error:"),
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
      }
    });
  };

  lifecycleAction(
    experiment
      .command("delete")
      .description("Cascade soft-delete an Experiment and poll its progress"),
    "DELETE",
    "",
    "deleted",
  );
  lifecycleAction(
    experiment
      .command("restore")
      .description("Restore an Experiment cascade and poll its progress"),
    "POST",
    "/restore",
    "restored",
  );

  withProjectOption(
    withOutputOption(
      experiment
        .command("status")
        .description("Show Experiment lifecycle progress and blockers")
        .argument("<id>", "Experiment ID")
        .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
    ),
  ).action(async (id: string, options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(
        options.url,
        `/experiments/${encodeURIComponent(id)}/lifecycle`,
        { projectId },
      );
      if (!response.ok) await throwApiError(response);
      const state = parseLifecycle(await json(response));
      console.log(
        formatData(
          [state as unknown as JsonRecord],
          [
            { key: "operationId", label: "Operation" },
            { key: "phase", label: "Phase" },
            { key: "stateVersion", label: "Version" },
            {
              key: "progress",
              label: "Requests",
              formatter: (row: JsonRecord) => {
                const progress = row.progress as ExperimentLifecycle["progress"];
                return `${progress.completedRequests}/${progress.expectedRequests}`;
              },
            },
            {
              key: "progress",
              label: "Reports",
              formatter: (row: JsonRecord) => {
                const progress = row.progress as ExperimentLifecycle["progress"];
                return `${progress.completedReports}/${progress.expectedReports}`;
              },
            },
          ],
          (options.output ?? "table") as OutputFormat,
        ),
      );
    } catch (error) {
      console.error(
        errorText("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    }
  });

  withProjectOption(
    withOutputOption(
      experiment
        .command("list")
        .description("List experiments")
        .option("--cursor <cursor>", "Continue from a list cursor")
        .option("--limit <number>", "Maximum items", Number.parseInt)
        .option("--include-deleted", "Include deleted Experiments")
        .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
    ),
  ).action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const params = new URLSearchParams();
      if (options.cursor) params.set("after", options.cursor);
      if (options.limit) params.set("limit", String(options.limit));
      if (options.includeDeleted) params.set("includeDeleted", "true");
      const response = await apiFetch(
        options.url,
        `/experiments${params.size ? `?${params}` : ""}`,
        { projectId },
      );
      if (!response.ok) await throwApiError(response);
      const page = parsePage(await json(response));
      console.log(
        formatData(
          page.items,
          fields,
          (options.output ?? "table") as OutputFormat,
        ),
      );
      if (page.nextCursor && !isMachineReadable(options.output ?? "table")) {
        console.log(`${label("Next cursor:")} ${value(page.nextCursor)}`);
      }
    } catch (error) {
      console.error(
        errorText("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    }
  });

  withProjectOption(
    withOutputOption(
      experiment
        .command("get")
        .description("Get an experiment and its current execution")
        .argument("<id>", "Experiment ID")
        .option("--include-deleted", "Include a deleted Experiment")
        .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
    ),
  ).action(async (id: string, options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(
        options.url,
        `/experiments/${encodeURIComponent(id)}${
          options.includeDeleted ? "?includeDeleted=true" : ""
        }`,
        { projectId },
      );
      if (!response.ok) await throwApiError(response);
      const item = parseExperiment(await json(response));
      const format = (options.output ?? "table") as OutputFormat;
      if (isMachineReadable(format)) {
        console.log(formatData([item], fields, format));
        return;
      }
      console.log(`${label("Experiment:")} ${value(item.experimentId)}`);
      console.log(`${label("Name:")} ${value(item.metadata.name)}`);
      console.log(
        `${label("Execution:")} ${value(item.execution.experimentExecutionId)}`,
      );
      console.log(
        `${label("Attempt:")} ${value(String(item.execution.attemptNumber))}`,
      );
      console.log(
        `${label("Readiness:")} ${value(item.readiness ?? "unknown")}`,
      );
      console.log(
        `${label("Runs:")} ${value(String(item.revision.memberCount))}`,
      );
    } catch (error) {
      console.error(
        errorText("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    }
  });

  withProjectOption(
    withOutputOption(
      experiment
        .command("executions")
        .description("List current and historical experiment executions")
        .argument("<id>", "Experiment ID")
        .argument("[executionId]", "Get one exact execution")
        .option("--cursor <cursor>", "Continue from a list cursor")
        .option("--limit <number>", "Maximum items", Number.parseInt)
        .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
    ),
  ).action(async (id: string, executionId: string | undefined, options) => {
    try {
      const projectId = requireProjectId(options.project);
      if (executionId) {
        const response = await apiFetch(
          options.url,
          `/experiments/${encodeURIComponent(id)}/executions/${encodeURIComponent(executionId)}`,
          { projectId },
        );
        if (!response.ok) await throwApiError(response);
        const item = parseExecution(await json(response));
        console.log(
          formatData(
            [item],
            [
              { key: "experimentExecutionId", label: "Execution" },
              { key: "attemptNumber", label: "Attempt" },
              { key: "readiness", label: "Readiness" },
              { key: "requestCount", label: "Runs" },
              { key: "supersededReason", label: "Superseded" },
              { key: "createdAt", label: "Created" },
            ],
            (options.output ?? "table") as OutputFormat,
          ),
        );
        return;
      }
      const params = new URLSearchParams();
      if (options.cursor) params.set("after", options.cursor);
      if (options.limit) params.set("limit", String(options.limit));
      const response = await apiFetch(
        options.url,
        `/experiments/${encodeURIComponent(id)}/executions${
          params.size ? `?${params}` : ""
        }`,
        { projectId },
      );
      if (!response.ok) await throwApiError(response);
      const page = parseExecutionPage(await json(response));
      console.log(
        formatData(
          page.items,
          [
            { key: "experimentExecutionId", label: "Execution" },
            { key: "attemptNumber", label: "Attempt" },
            { key: "readiness", label: "Readiness" },
            { key: "requestCount", label: "Runs" },
            { key: "supersededReason", label: "Superseded" },
            { key: "createdAt", label: "Created" },
          ],
          (options.output ?? "table") as OutputFormat,
        ),
      );
    } catch (error) {
      console.error(
        errorText("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    }
  });

  withProjectOption(
    withOutputOption(
      experiment
        .command("reports")
        .description("List or retrieve reports for one exact experiment execution")
        .argument("<id>", "Experiment ID")
        .argument("<executionId>", "Experiment execution ID")
        .option("--report <reportId>", "Select one report")
        .option("--template <templateId>", "Filter by report template/type")
        .option("--structured", "Print the selected report's structured JSON artifact")
        .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
      ["markdown"],
    ),
  ).action(async (id: string, executionId: string, options) => {
    try {
      const projectId = requireProjectId(options.project);
      const path =
        `/experiments/${encodeURIComponent(id)}/executions/${encodeURIComponent(executionId)}/reports`;
      const response = await apiFetch(options.url, path, { projectId });
      if (!response.ok) await throwApiError(response);
      const reportsValue = await json(response);
      if (!Array.isArray(reportsValue)) {
        throw new Error("Invalid experiment reports response from Scope");
      }
      const reports = reportsValue.map((item) =>
        asRecord(item, "experiment report"),
      ).filter((item) =>
        options.template ? item.templateId === options.template : true
      );
      const selected = options.report
        ? reports.find((item) => item.id === options.report)
        : reports[0];
      if (options.report && !selected) {
        throw new Error(`Report ${options.report} was not found for this execution`);
      }
      if (options.structured) {
        if (!selected) {
          throw new Error("No report is available for this execution");
        }
        const reportId = stringField(selected, "id", "experiment report")!;
        const structuredResponse = await apiFetch(
          options.url,
          `${path}/${encodeURIComponent(reportId)}/structured`,
          { projectId },
        );
        if (!structuredResponse.ok) await throwApiError(structuredResponse);
        console.log(JSON.stringify(await json(structuredResponse), null, 2));
        return;
      }
      const format = (options.output ?? "table") as OutputFormat;
      if (format === "markdown") {
        console.log(selected?.content ?? "");
        return;
      }
      console.log(
        formatData(
          options.report && selected ? [selected] : reports,
          [
            { key: "id", label: "Report" },
            { key: "templateId", label: "Type" },
            { key: "reportVersion", label: "Version" },
            { key: "status", label: "Status" },
            {
              key: "reporter",
              label: "Reporter",
              formatter: (row: JsonRecord) =>
                String((row.reporter as JsonRecord | undefined)?.name ?? ""),
            },
            { key: "createdAt", label: "Created" },
            { key: "updatedAt", label: "Updated" },
          ],
          format,
        ),
      );
    } catch (error) {
      console.error(
        errorText("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    }
  });

  withProjectOption(
    experiment
      .command("report-retry")
      .description(
        "Retry one template report in the same exact Experiment execution",
      )
      .argument("<id>", "Experiment ID")
      .requiredOption("--execution <id>", "Exact Experiment execution ID")
      .requiredOption("--template <id>", "Experiment report template ID")
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (id: string, options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(
        options.url,
        `/experiments/${encodeURIComponent(id)}/executions/${encodeURIComponent(options.execution)}/reports/${encodeURIComponent(options.template)}/retry`,
        { method: "POST", projectId },
      );
      if (!response.ok) await throwApiError(response);
      const report = asRecord(await json(response), "experiment report retry");
      console.log(
        `${successText("Experiment report retry queued:")} ${value(
          stringField(report, "id", "experiment report retry")!,
        )}`,
      );
    } catch (error) {
      console.error(
        errorText("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    }
  });

  withProjectOption(
    experiment
      .command("logs")
      .description("Stream logs for one exact experiment execution")
      .argument("<id>", "Experiment ID")
      .argument("<executionId>", "Experiment execution ID")
      .option("--from-start", "Include historical logs from the beginning", false)
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (id: string, executionId: string, options) => {
    const projectId = requireProjectId(options.project);
    const params = new URLSearchParams({ projectId });
    if (options.fromStart) params.set("fromStart", "true");
    const eventSource = new EventSource(
      `${normalizeUrl(options.url)}${getApiBasePath()}/experiments/${encodeURIComponent(id)}/executions/${encodeURIComponent(executionId)}/logs?${params}`,
    );
    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const log = JSON.parse(event.data) as {
          timestamp: string;
          level: string;
          source?: string;
          message: string;
        };
        const source = log.source ? ` [${log.source}]` : "";
        console.log(
          `${new Date(log.timestamp).toLocaleTimeString()} ${log.level}${source} ${log.message}`,
        );
      } catch {
        console.log(event.data);
      }
    };
    eventSource.addEventListener("done", () => {
      eventSource.close();
      process.exit(0);
    });
    eventSource.addEventListener("timeout", () => {
      eventSource.close();
      process.exit(0);
    });
    eventSource.onerror = () => {
      eventSource.close();
      process.exit(1);
    };
  });

  withProjectOption(
    experiment
      .command("retry")
      .description("Retry the current experiment execution")
      .argument("<id>", "Experiment ID")
      .requiredOption(
        "--execution <id>",
        "Current experiment execution ID",
      )
      .option("-u, --url <url>", "API base URL", getDefaultApiUrl()),
  ).action(async (id: string, options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(
        options.url,
        `/experiments/${encodeURIComponent(id)}/retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            experimentExecutionId: options.execution,
          }),
          projectId,
        },
      );
      if (!response.ok) await throwApiError(response);
      const item = asRecord(await json(response), "experiment retry");
      console.log(
        successText(
          `Experiment retry started: attempt ${numberField(item, "attemptNumber", "experiment retry")} (${stringField(item, "experimentExecutionId", "experiment retry")})`,
        ),
      );
    } catch (error) {
      console.error(
        errorText("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    }
  });
}
