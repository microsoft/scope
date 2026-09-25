// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command, Option } from "commander";
import EventSource from "eventsource";
import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, createWriteStream, rmSync, readFileSync, readdirSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname, basename } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { resolveScenarioAndPersona } from "../config-loader.js";
import { configureHelp } from "../utils/helpFormatter.js";
import { colorLevel, dimTimestamp, errorText, successText, label, value, banner, warnBanner, criterionIcon, styleText } from "../utils/style.js";
import { formatData, isMachineReadable, formatDate } from "../utils/formatters.js";
import type { OutputFormat, DisplayField } from "../utils/types.js";
import { runGetAction } from "../run-get-action.js";
import { normalizeUrl, printFollowUpCommands, withOutputOption, withProjectOption, getDefaultApiUrl } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch, getApiBasePath } from "../utils/api-client.js";
import { parseGatesOption } from "../utils/gates.js";
import { buildResourceBindingSpecs, collectRepeatable } from "../utils/resources.js";

/**
 * Resolve a CLI option that may be either a literal string or a `@path`
 * reference to a file whose contents should be read. Used for flags like
 * `--agents-md` where large bodies are inconvenient to pass inline.
 */
function resolveTextOrFile(input: string): string {
  if (input.startsWith("@")) {
    return readFileSync(resolve(input.slice(1)), "utf8");
  }
  return input;
}

interface ApiErrorBody {
  error?: unknown;
  errors?: unknown;
  conflicts?: unknown;
}

function formatApiErrorBody(body: ApiErrorBody): string {
  const lines: string[] = [];
  if (typeof body.error === "string") {
    lines.push(body.error);
  } else if (body.error !== undefined) {
    lines.push(JSON.stringify(body.error));
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    lines.push("Errors:");
    lines.push(...body.errors.map((item) => `  - ${String(item)}`));
  }
  if (Array.isArray(body.conflicts) && body.conflicts.length > 0) {
    lines.push("Conflicts:");
    lines.push(...body.conflicts.map((item) => `  - ${String(item)}`));
  }
  return lines.length > 0 ? lines.join("\n") : JSON.stringify(body);
}

export function registerRunCommands(program: Command): void {
const run = program
  .command("run")
  .description("Submit, monitor, and manage benchmark runs")
  .action(() => {
    run.help();
  });

configureHelp(run);

run
  .command("submit")
  .description("Submit a request to a worker and stream logs")
  .option("-s, --scenario <path>", "Path to scenario YAML file (provides task + criteria)")
  .option("-p, --persona <path>", "Path to persona YAML file (provides judge personality)")
  .option("-t, --traits <path>", "Path to traits.yaml (default: config/traits.yaml next to persona)")
  .option("-m, --message <message>", "Message/task to process (overrides scenario task)")
  .option("-w, --worker <worker>", "Registered worker ID (see `scope agent list`)")
  .option("-c, --criteria <criteria...>", "Evaluation criteria (overrides scenario criteria)")
  .option("--max-iterations <number>", "Max judge iterations for multi-turn mode", parseInt)
  .option("--model <model>", "Model to use for the coding agent")
  .option("--reasoning-effort <level>", "Reasoning effort level (e.g. low, medium, high)")
  .option("--mcp-servers <slugs...>", "MCP server slugs to use for this run")
  .option("--skills <slugs...>", "Skill slugs to use for this run (e.g. vercel-labs/agent-skills/my-skill)")
  .option("--codebase <ref>", "Codebase revision id, ref (slug@rN), or slug to use for this run")
  .option("--resources <specs...>", "Resources to provision for this run (slug, slug@rN, or revision id), in setup order")
  .option("--resource-param <slug>:<KEY>=<VALUE>", "Resource parameter value (repeatable); matches a --resources entry or profile resource by slug", collectRepeatable, [])
  .option("--extensions <ids...>", "VS Code extension IDs to install for this run (e.g. ms-python.python)")
  .option("--agent-version <version>", "Agent version to target (e.g. copilot-0.0.415); defaults to latest active")
  .option("--profile <id>", "Saved profile to apply (supplies worker, model, extensions, etc.)")
  .addOption(new Option("--base-profile <id>", "Deprecated alias for --profile.").hideHelp())
  .option("--profile-variations-file <path>", "Path to JSON file containing profile variation entries")
  .option("--agents-md <text|@file>", "AGENTS.md content delivered to the workspace (prefix with @ to read from a file)")
  .option("--gates <jsonOrFile>", "GateConfig[] JSON or path/@path to a JSON file for gated runs")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .option("--count <number>", "Submit this run N times (1-10). With --profile-variations-file, N runs per profile — repetition is how you separate a real difference between profiles from model variance", (v: string) => Number.parseInt(v, 10))
  .option("--no-stream", "Don't stream logs, just submit")
  .action(async (options, command) => {
    const { scenario, persona, traits, worker, url, stream, count, maxIterations, model, reasoningEffort, mcpServers: mcpServerSlugs, skills: skillSlugs, codebase: codebaseRef, resources: resourceSpecs, resourceParam: resourceParamOverrides, extensions: extensionIds, agentVersion, profile, baseProfile, profileVariationsFile, gates: gatesOption, agentsMd: agentsMdInput } = options;
    // `--profile` is the documented flag; `--base-profile` is kept as a hidden
    // back-compat alias. Both resolve to the same request `profileId`.
    const profileId = profile ?? baseProfile;
    // Fail fast: submitting a run is a root create and requires an explicit project.
    const projectId = requireProjectId(options.project);

    try {
      // Resolve scenario + persona YAML if provided
      let message = options.message;
      let criteria = options.criteria;
      let personaInstructions: string | undefined;
      let personaObj: Record<string, unknown> | undefined;

      if (scenario) {
        const resolved = resolveScenarioAndPersona(scenario, persona, traits);
        // Scenario provides task and criteria (CLI flags override)
        if (!message) message = resolved.task;
        if (!criteria || criteria.length === 0) criteria = resolved.criteria;
        personaInstructions = resolved.personaInstructions;
        personaObj = resolved.persona;

        console.log(`${label('Scenario:')} ${value(scenario)}`);
        if (persona) console.log(`${label('Persona:')} ${value(persona)}`);
        console.log(`${label('Task:')} ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
        console.log(`${label('Criteria:')} ${value(String(criteria.length))} items`);
        console.log();
      }

      if (!message) {
        console.error(errorText("Error: --message or --scenario is required"));
        process.exit(1);
      }

      // Build request body — scenario is the source of truth
      const body: Record<string, unknown> = {
        scenario: {
          task: message,
          criteria: criteria || [],
        },
      };
      if (count !== undefined) {
        if (!Number.isInteger(count) || count < 1 || count > 10) {
          console.error(errorText("Error: --count must be an integer between 1 and 10."));
          process.exit(1);
        }
        body.count = count;
      }
      if (maxIterations) {
        body.maxIterations = maxIterations;
      }
      if (model) {
        body.model = model;
      }
      if (reasoningEffort) {
        body.reasoningEffort = reasoningEffort;
      }
      if (personaInstructions) {
        body.personaInstructions = personaInstructions;
      }
      if (personaObj) {
        body.persona = personaObj;
      }
      if (mcpServerSlugs && mcpServerSlugs.length > 0) {
        body.mcpServers = mcpServerSlugs;
      }
      if (skillSlugs && skillSlugs.length > 0) {
        body.skills = skillSlugs;
      }
      const resources = buildResourceBindingSpecs(resourceSpecs, resourceParamOverrides);
      if (resources) {
        body.resources = resources;
      }
      if (codebaseRef) {
        body.codebase = codebaseRef;
      }
      if (extensionIds && extensionIds.length > 0) {
        body.extensions = extensionIds;
      }
      if (agentVersion) {
        body.agentVersion = agentVersion;
      }
      if (profileId) {
        body.profileId = profileId;
      }
      if (agentsMdInput) {
        // `@path` reads the AGENTS.md body from a file; otherwise the value is
        // treated as the literal content.
        const agentsMd = resolveTextOrFile(agentsMdInput);
        if (agentsMd.trim().length > 0) {
          body.agentsMd = agentsMd;
        }
      }
      if (gatesOption) {
        body.gates = parseGatesOption(gatesOption, maxIterations);
      }

      if (profileVariationsFile) {
        if (!profileId) {
          console.error(errorText("Error: --profile is required when --profile-variations-file is provided"));
          process.exit(1);
        }

        const raw = readFileSync(resolve(profileVariationsFile), "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) {
          console.error(errorText("Error: profile variations file must be a JSON array"));
          process.exit(1);
        }

        body.profileVariations = parsed;
      }

      // In variation mode the API derives the worker per-variation from each
      // profile's workerType, and explicitly rejects `?worker=`. Skip the
      // query param so the request isn't 400'd, and warn if --worker was
      // explicitly passed (default values are silently ignored).
      const isVariationSubmit = Array.isArray(body.profileVariations) && body.profileVariations.length > 0;
      if (isVariationSubmit && command.getOptionValueSource("worker") === "cli") {
        console.warn(label("Warning:"), "--worker is ignored in variation mode; worker is derived per-variation from each profile's workerType.");
      }
      if (!isVariationSubmit && !profileId && !worker) {
        console.error(
          errorText(
            "Error: --worker is required without --profile. Use `scope agent list` to see currently registered workers.",
          ),
        );
        process.exit(1);
      }
      const submitPath =
        isVariationSubmit || !worker
          ? `/requests`
          : `/requests?worker=${encodeURIComponent(worker)}`;

      const response = await apiFetch(url, submitPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        projectId,
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ error: response.statusText }))) as ApiErrorBody;
        console.error(errorText("Error:"), formatApiErrorBody(error));
        process.exit(1);
      }

      const result = await response.json();

      // A variation submit creates one request per profile and returns
      // { ids, variations, submissionId, ... } with no `id` or `workerType`.
      // Printing it through the single-request path rendered `undefined` and
      // then crashed in chalk, so the whole submission looked like it failed
      // when in fact every request had been created.
      if (Array.isArray(result.ids) && result.ids.length > 0 && !result.id) {
        console.log(`${successText('Submitted:')} ${value(String(result.count ?? result.ids.length))} request(s) across ${value(String(result.variationCount ?? result.ids.length))} profile(s)`);
        if (result.submissionId) console.log(`${label('Submission:')} ${value(result.submissionId)}`);
        for (const variation of (result.variations ?? [])) {
          const ids: string[] = variation.ids ?? (variation.id ? [variation.id] : []);
          const name = variation.label ?? variation.profileName ?? variation.profileId ?? 'variation';
          console.log(`  ${label(String(name))} ${value(ids.join(', '))}`);
        }
        console.log(`${label('Status:')} ${value(result.status)}`);
        for (const warning of (Array.isArray(result.warnings) ? result.warnings : [])) {
          console.log(`${errorText('⚠ Warning:')} ${warning}`);
        }
        // Streaming follows a single request; a submission has several.
        printFollowUpCommands(result.ids[0]);
        return;
      }

      console.log(`${successText('Request submitted:')} ${value(result.id)}`);
      if (result.submissionId) console.log(`${label('Submission:')} ${value(result.submissionId)}`);
      console.log(`${label('Worker:')} ${value(result.workerType)}`);
      if (result.model) console.log(`${label('Model:')} ${value(result.model)}`);
      if (result.reasoningEffort) console.log(`${label('Reasoning Effort:')} ${value(result.reasoningEffort)}`);
      console.log(`${label('Mode:')} ${value(result.mode || 'one-shot')}`);
      if (Array.isArray(body.gates)) console.log(`${label('Gates:')} ${value(String(body.gates.length))}`);
      console.log(`${label('Status:')} ${value(result.status)}`);

      // Display warnings (e.g. model effort compatibility)
      if (result.warnings && Array.isArray(result.warnings)) {
        for (const warning of result.warnings) {
          console.log(`${errorText('⚠ Warning:')} ${warning}`);
        }
      }
      if (!stream) {
        printFollowUpCommands(result.id);
        return;
      }

      // Stream logs
      console.log(`\n${banner('--- Streaming logs ---')}\n`);

      const eventSource = new EventSource(`${normalizeUrl(url)}${getApiBasePath()}/requests/${result.id}/logs`);

      eventSource.onmessage = (event) => {
        try {
          const log = JSON.parse(event.data);
          const timestamp = new Date(log.timestamp).toLocaleTimeString();
          const src = log.source ? `[${log.source}] ` : '';
          const iter = log.data?.iteration != null ? `[iter ${log.data.iteration}] ` : '';

          // Detect special criterion/DAG log events and render them with status icons
          if (log.data?.type === "criterion_result") {
            const d = log.data;
            const icon = criterionIcon(d.evaluated, d.passed);
            console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter} ${icon} ${d.criterionId}`);
            if (d.feedback && !d.passed && d.evaluated) {
              console.log(`           ${styleText('gray', d.feedback.substring(0, 120))}`);
            }
            return;
          }

          if (log.data?.type === "criteria_dag_status") {
            console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter}${log.message}`);
            const results = log.data.results as Array<{ criterionId: string; passed: boolean; evaluated: boolean; feedback: string }>;
            if (results) {
              for (const r of results) {
                const icon = criterionIcon(r.evaluated, r.passed);
                console.log(`              ${icon} ${r.criterionId}`);
              }
            }
            return;
          }

          console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter}${log.message}`);
          if (log.data) {
            // Filter out keys already rendered in the log line prefix
            const { iteration: _iter, type: _type, ...rest } = log.data;
            if (Object.keys(rest).length > 0) {
              const dataStr = JSON.stringify(rest, null, 2)
                .split("\n")
                .map((line) => `           ${line}`)
                .join("\n");
              console.log(dataStr);
            }
          }
        } catch {
          console.log(event.data);
        }
      };

      eventSource.addEventListener("done", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data);
          console.log(`\n${successText(`--- Processing ${data.status} ---`)}`);
        } catch {
          console.log(`\n${successText('--- Done ---')}`);
        }
        printFollowUpCommands(result.id);
        eventSource.close();
        process.exit(0);
      });

      eventSource.addEventListener("error", () => {
        console.error(`\n${errorText('--- Connection error ---')}`);
        eventSource.close();
        process.exit(1);
      });

      eventSource.addEventListener("timeout", () => {
        console.log(`\n${warnBanner('--- Stream timeout ---')}`);
        eventSource.close();
        process.exit(0);
      });

    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
run
  .command("status")
  .description("Get status of a request")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const { id } = options;
    try {
      const response = await apiFetch(options.url, `/requests/${id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error);
        process.exit(1);
      }

      const request = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'workerType', label: 'Worker' },
          { key: 'status', label: 'Status' },
          { key: 'mode', label: 'Mode' },
          { key: 'createdAt', label: 'Created' },
          { key: 'completedAt', label: 'Completed' },
        ];
        const row = { ...request, status: request.run?.status };
        console.log(formatData([row], fields, format));
        return;
      }

      console.log(`${label('ID:')} ${value(request.id)}`);
      console.log(`${label('Worker:')} ${value(request.workerType)}`);
      console.log(`${label('Status:')} ${value(request.run?.status ?? 'unknown')}`);
      if (request.mode) console.log(`${label('Mode:')} ${value(request.mode)}`);
      if (request.createdAt) console.log(`${label('Created:')} ${value(request.createdAt)}`);
      if (request.completedAt) console.log(`${label('Completed:')} ${value(request.completedAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
run
  .command("get")
  .description("Get full details of a run")
  .requiredOption("-i, --id <id>", "Run ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    await runGetAction({ id: options.id, url: options.url, output: options.output });
  });

run
  .command("logs")
  .description("Stream logs for a request")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--from-start", "Include historical logs from start")
  .action(async (options) => {
    const { id } = options;
    const url = options.fromStart
      ? `${normalizeUrl(options.url)}${getApiBasePath()}/requests/${id}/logs?fromStart=true`
      : `${normalizeUrl(options.url)}${getApiBasePath()}/requests/${id}/logs`;

    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const log = JSON.parse(event.data);
        const timestamp = new Date(log.timestamp).toLocaleTimeString();
        const src = log.source ? `[${log.source}] ` : '';
        const iter = log.data?.iteration != null ? `[iter ${log.data.iteration}] ` : '';

        if (log.data?.type === "criterion_result") {
          const d = log.data;
          const icon = criterionIcon(d.evaluated, d.passed);
          console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter} ${icon} ${d.criterionId}`);
          return;
        }

        if (log.data?.type === "criteria_dag_status") {
          console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter}${log.message}`);
          const results = log.data.results as Array<{ criterionId: string; passed: boolean; evaluated: boolean }>;
          if (results) {
            for (const r of results) {
              const icon = criterionIcon(r.evaluated, r.passed);
              console.log(`              ${icon} ${r.criterionId}`);
            }
          }
          return;
        }

        console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter}${log.message}`);
      } catch {
        console.log(event.data);
      }
    };

    eventSource.addEventListener("done", () => {
      console.log(`\n${successText('--- Done ---')}`);
      eventSource.close();
      process.exit(0);
    });

    eventSource.addEventListener("error", () => {
      console.error(`\n${errorText('--- Connection error ---')}`);
      eventSource.close();
      process.exit(1);
    });
  });

withProjectOption(withOutputOption(
run
  .command("list")
  .description("List all requests")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("-w, --worker <worker...>", "Filter by worker (repeatable)")
  .option("--status <status...>", "Filter by run status (repeatable; '__empty__' = unknown)")
  .option("--outcome <outcome...>", "Filter by run outcome (repeatable; '__empty__' = unknown)")
  .option("--task <taskPromptId>", "Filter by task prompt ID")
  .option("--profile <id...>", "Filter by profile ID (repeatable; '__empty__' = unknown)")
  .option("--criteria <id>", "Filter by criteria ID")
  .option("--model <model...>", "Filter by model (repeatable; '__empty__' = unknown)")
  .option("--os <platform...>", "Filter by OS platform (repeatable; '__empty__' = unknown)")
  .option("--priority <priority...>", "Filter by priority (repeatable; '__empty__' = unknown)")
  .option("--agent-version <version...>", "Filter by agent version (repeatable; '__empty__' = unknown)")
  .option("--search <text>", "Free-text search over id, task, model, and worker")
  .option("--created-after <iso>", "Only runs created at/after this ISO-8601 datetime")
  .option("--created-before <iso>", "Only runs created at/before this ISO-8601 datetime")
  .option("--submission-id <id>", "Filter by submission ID")
  .option("--turns <expr>", "Filter by actual turns (e.g. '>=5', '<=10', '=3')")
  .option("--max-iterations <expr>", "Filter by configured maxIterations (e.g. '>=5', '<=10', '=3')")
  .option("--sort-by <field>", "Sort field: created, updated, priority, worker, status, id, duration")
  .option("--sort-dir <dir>", "Sort direction: asc or desc")
  .option("--include-deleted", "Include soft-deleted runs")
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      let path = `/requests`;
      const params = new URLSearchParams();
      const appendMulti = (key: string, vals?: string[] | string) => {
        if (vals == null) return;
        const arr = Array.isArray(vals) ? vals : [vals];
        for (const v of arr) params.append(key, String(v));
      };
      appendMulti("worker", options.worker);
      appendMulti("status", options.status);
      appendMulti("outcome", options.outcome);
      appendMulti("profileId", options.profile);
      appendMulti("model", options.model);
      appendMulti("os", options.os);
      appendMulti("priority", options.priority);
      appendMulti("agentVersion", options.agentVersion);
      if (options.task) {
        params.set("taskPromptId", options.task);
      }
      if (options.criteria) {
        params.set("criteria", options.criteria);
      }
      if (options.search) {
        params.set("search", options.search);
      }
      if (options.createdAfter) {
        params.set("createdAfter", options.createdAfter);
      }
      if (options.createdBefore) {
        params.set("createdBefore", options.createdBefore);
      }
      if (options.submissionId) {
        params.set("submissionId", options.submissionId);
      }
      const parseIterExpr = (raw: string, name: string): { op: "eq" | "gte" | "lte"; value: number } => {
        const m = /^(>=|<=|=)?\s*(\d+)$/.exec(String(raw).trim());
        if (!m) {
          throw new Error(`Invalid ${name} expression '${raw}'. Use forms like '>=5', '<=10', '=3', or '5'.`);
        }
        const opSym = m[1] ?? "=";
        const op = opSym === ">=" ? "gte" : opSym === "<=" ? "lte" : "eq";
        return { op, value: Number(m[2]) };
      };
      if (options.turns !== undefined) {
        const { op, value } = parseIterExpr(options.turns, "--turns");
        params.set("turns", String(value));
        params.set("turnsOp", op);
      }
      if (options.maxIterations !== undefined) {
        const { op, value } = parseIterExpr(options.maxIterations, "--max-iterations");
        params.set("maxIterations", String(value));
        params.set("maxIterationsOp", op);
      }
      if (options.includeDeleted) {
        params.set("includeDeleted", "true");
      }
      if (options.sortBy) {
        params.set("sortBy", options.sortBy);
      }
      if (options.sortDir) {
        params.set("sortDir", options.sortDir);
      }
      const qs = params.toString();
      if (qs) path += `?${qs}`;

      const response = await apiFetch(options.url, path, { projectId });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error);
        process.exit(1);
      }

      const responseBody = await response.json();
      const requests = Array.isArray(responseBody)
        ? responseBody
        : Array.isArray(responseBody?.data)
          ? responseBody.data
          : [];

      if (requests.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner('No requests found.'));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${requests.length} request(s):\n`));
      }

      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID',
          formatter: (req: any) => req.id ?? '(no id)',
          tableFormatter: (req: any) => value(req.id ?? '(no id)'),
        },
        { key: 'workerType', label: 'Worker',
          formatter: (req: any) => req.workerType ?? 'unknown',
        },
        { key: 'status', label: 'Status',
          formatter: (req: any) => req.run?.status ?? 'unknown',
          tableFormatter: (req: any) => {
            const s = req.run?.status ?? 'unknown';
            const o = req.run?.outcome;
            return o === 'succeeded' ? successText(s) : o === 'failed' || o === 'finished' ? errorText(s) : value(s);
          },
        },
        { key: 'submissionId', label: 'Submission',
          formatter: (req: any) => req.submissionId ? req.submissionId.substring(0, 8) : '–',
        },
        { key: 'createdAt', label: 'Created',
          formatter: (req: any) => formatDate(req.createdAt),
        },
        { key: 'updatedAt', label: 'Updated',
          formatter: (req: any) => formatDate(req.updatedAt),
        },
      ];

      console.log(formatData(requests, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

run
  .command("delete")
  .description("Soft-delete a run (can still be listed with --include-deleted)")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    const { id, url } = options;
    try {
      const response = await apiFetch(url, `/requests/${id}`, { method: "DELETE" });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(`${successText('Deleted run')} ${value(id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

run
  .command("cancel")
  .description("Cancel one or more runs (marks as failed and signals active workers to exit)")
  .requiredOption("-i, --id <ids...>", "Request ID(s) to cancel")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    const { id: ids, url } = options;
    try {
      if (ids.length === 1) {
        const response = await apiFetch(url, `/requests/${ids[0]}/cancel`, { method: "POST" });
        if (!response.ok) {
          const error = await response.json();
          console.error(errorText("Error:"), error.error || JSON.stringify(error));
          process.exit(1);
        }
        const result = await response.json() as { id: string; previousStatus: string; status: string; outcome: string };
        console.log(`${successText('Cancelled run')} ${value(result.id)} (was ${result.previousStatus})`);
      } else {
        const response = await apiFetch(url, `/requests/bulk-cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        if (!response.ok) {
          const error = await response.json();
          console.error(errorText("Error:"), error.error || JSON.stringify(error));
          process.exit(1);
        }
        const result = await response.json() as { cancelled: number; skipped: number; results: { id: string; cancelled: boolean; previousStatus?: string; error?: string }[] };
        for (const r of result.results) {
          if (r.cancelled) {
            console.log(`${successText('Cancelled')} ${value(r.id)} (was ${r.previousStatus})`);
          } else {
            console.log(`${errorText('Skipped')} ${value(r.id)}: ${r.error}`);
          }
        }
        console.log(`\n${label('Total:')} ${result.cancelled} cancelled, ${result.skipped} skipped`);
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

run
  .command("download")
  .description("Download all artifacts of a run (workspaces + run document)")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-o, --output <path>", "Output file path (default: <id>.tar.gz)")
  .option("-e, --extract", "Extract the archive after downloading")
  .option("-d, --dir <path>", "Extraction directory (implies --extract)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    const { id, url } = options;
    const shouldExtract = options.extract || !!options.dir;
    const downloadDir = process.env.SCOPE_MT_DOWNLOAD_OUTPUT_DIR;
    const defaultFile = downloadDir ? join(downloadDir, `${id}.tar.gz`) : `${id}.tar.gz`;
    const outputFile = options.output || defaultFile;

    try {
      // Step 1: Fetch request document (lightweight — for metadata display)
      console.log(`${label('Fetching run')} ${value(id)}...`);
      const response = await apiFetch(url, `/requests/${id}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error);
        process.exit(1);
      }
      const request = await response.json();

      if (!request.run?.turns || request.run.turns.length === 0) {
        console.error(errorText("Error: No iterations found for this run"));
        process.exit(1);
      }

      console.log(`${label('Status:')} ${value(request.run?.status ?? 'unknown')}`);
      console.log(`${label('Worker:')} ${value(request.workerType)}`);
      console.log(`${label('Iterations:')} ${value(String(request.run.turns.length))}`);
      console.log();

      // Step 2: Download the full archive from the server
      console.log(`${label('Downloading archive')}...`);
      const archiveResp = await apiFetch(url, `/requests/${id}/archive`);
      if (!archiveResp.ok || !archiveResp.body) {
        const error = await archiveResp.json().catch(() => ({ error: archiveResp.statusText }));
        console.error(errorText("Error downloading archive:"), error);
        process.exit(1);
      }

      const outputPath = resolve(outputFile);
      mkdirSync(dirname(outputPath), { recursive: true });
      const fileStream = createWriteStream(outputPath);
      await pipeline(Readable.fromWeb(archiveResp.body as any), fileStream);
      console.log(`${successText('Archive:')} ${value(outputPath)}`);

      // Step 3: Optionally extract
      if (shouldExtract) {
        const extractDir = options.dir || downloadDir || ".";
        mkdirSync(extractDir, { recursive: true });
        execSync(`tar xzf "${outputPath}" -C "${extractDir}"`, { stdio: "pipe" });

        // Extract nested iteration-*.tar.gz files into iteration-N/ directories
        const runExtractDir = join(extractDir, id);
        if (existsSync(runExtractDir)) {
          const nestedArchives = readdirSync(runExtractDir).filter(f => f.startsWith("iteration-") && f.endsWith(".tar.gz"));
          for (const archive of nestedArchives) {
            const iterName = archive.replace(".tar.gz", "");
            const iterDir = join(runExtractDir, iterName);
            mkdirSync(iterDir, { recursive: true });
            execSync(`tar xzf "${join(runExtractDir, archive)}" -C "${iterDir}"`, { stdio: "pipe" });
            rmSync(join(runExtractDir, archive), { force: true });
          }
        }

        rmSync(outputPath, { force: true });
        console.log(`${successText('Extracted to:')} ${value(resolve(extractDir, id))}`);
      }

    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

run
  .command("download-batch")
  .description("Download multiple runs at once into a single batch archive")
  .option("-i, --ids <ids...>", "One or more run IDs")
  .option("--submission-id <id>", "Download all runs for a submission")
  .option("-o, --output <path>", "Output file path (default: batch-<timestamp>.tar.gz)")
  .option("-e, --extract", "Extract the archive after downloading")
  .option("-d, --dir <path>", "Extraction directory (implies --extract)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (required with --submission-id)")
  .action(async (options) => {
    const { url } = options;
    const shouldExtract = options.extract || !!options.dir;

    try {
      // Resolve IDs: either from --ids or by querying --submission-id
      let ids: string[] = options.ids || [];

      if (options.submissionId) {
        console.log(`${label('Fetching runs for submission')} ${value(options.submissionId)}...`);
        const projectId = requireProjectId(options.project);
        const listResp = await apiFetch(url, `/requests?submissionId=${encodeURIComponent(options.submissionId)}&limit=1000`, { projectId });
        if (!listResp.ok) {
          const error = await listResp.json();
          console.error(errorText("Error fetching runs:"), error);
          process.exit(1);
        }
        const listData = await listResp.json();
        const runs = listData.data || listData;
        if (!Array.isArray(runs) || runs.length === 0) {
          console.error(errorText("No runs found for this submission"));
          process.exit(1);
        }
        ids = runs.map((r: { _id: string }) => r._id);
        console.log(`${label('Found')} ${value(String(ids.length))} runs`);
      }

      if (ids.length === 0) {
        console.error(errorText("Error: provide --ids or --submission-id"));
        process.exit(1);
      }

      // Determine output file
      const downloadDir = process.env.SCOPE_MT_DOWNLOAD_OUTPUT_DIR;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const defaultFile = downloadDir ? join(downloadDir, `batch-${timestamp}.tar.gz`) : `batch-${timestamp}.tar.gz`;
      const outputFile = options.output || defaultFile;

      console.log(`${label('Downloading batch archive for')} ${value(String(ids.length))} runs...`);

      // POST to batch archive endpoint
      const archiveResp = await apiFetch(url, `/requests/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!archiveResp.ok || !archiveResp.body) {
        const error = await archiveResp.json().catch(() => ({ error: archiveResp.statusText }));
        console.error(errorText("Error downloading batch archive:"), error);
        process.exit(1);
      }

      const outputPath = resolve(outputFile);
      mkdirSync(dirname(outputPath), { recursive: true });
      const fileStream = createWriteStream(outputPath);
      await pipeline(Readable.fromWeb(archiveResp.body as any), fileStream);
      console.log(`${successText('Archive:')} ${value(outputPath)}`);

      // Optionally extract
      if (shouldExtract) {
        const extractDir = options.dir || downloadDir || ".";
        mkdirSync(extractDir, { recursive: true });
        execSync(`tar xzf "${outputPath}" -C "${extractDir}"`, { stdio: "pipe" });

        // Extract nested iteration-*.tar.gz files for each run directory
        const extractedEntries = readdirSync(extractDir).filter(f => {
          const fullPath = join(extractDir, f);
          return statSync(fullPath).isDirectory() && existsSync(join(fullPath, "run.yaml"));
        });

        for (const runDir of extractedEntries) {
          const runExtractDir = join(extractDir, runDir);
          const nestedArchives = readdirSync(runExtractDir).filter(f => f.startsWith("iteration-") && f.endsWith(".tar.gz"));
          for (const archive of nestedArchives) {
            const iterName = archive.replace(".tar.gz", "");
            const iterDir = join(runExtractDir, iterName);
            mkdirSync(iterDir, { recursive: true });
            execSync(`tar xzf "${join(runExtractDir, archive)}" -C "${iterDir}"`, { stdio: "pipe" });
            rmSync(join(runExtractDir, archive), { force: true });
          }
        }

        rmSync(outputPath, { force: true });
        console.log(`${successText('Extracted')} ${value(String(extractedEntries.length))} runs to ${value(resolve(extractDir))}`);
      }

    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

run
  .command("upload")
  .description("Upload a run archive to the API (previously downloaded via 'run download')")
  .argument("<path>", "Path to .tar.gz archive or extracted directory")
  .option("--dry-run", "Preview what would be uploaded without sending")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (inputPath: string, options) => {
    const { url, dryRun } = options;

    try {
      const resolvedPath = resolve(inputPath);
      
      // Check if path exists
      if (!existsSync(resolvedPath)) {
        console.error(errorText(`Path not found: ${resolvedPath}`));
        process.exit(1);
      }

      const stats = statSync(resolvedPath);
      let archivePath: string;
      let tempDir: string | undefined;

      if (stats.isDirectory()) {
        // Directory: validate run.yaml exists, then create tar.gz
        const runYamlPath = join(resolvedPath, "run.yaml");
        if (!existsSync(runYamlPath)) {
          console.error(errorText(`Invalid directory: run.yaml not found at ${runYamlPath}`));
          process.exit(1);
        }

        // Create temporary tar.gz archive
        tempDir = mkdtempSync(join(tmpdir(), "scope-mt-upload-"));
        archivePath = join(tempDir, `${basename(resolvedPath)}.tar.gz`);
        
        console.log(`${label('Creating archive from')} ${value(resolvedPath)}...`);
        execSync(`tar czf "${archivePath}" -C "${dirname(resolvedPath)}" "${basename(resolvedPath)}"`, { stdio: "pipe" });
      } else if (resolvedPath.endsWith(".tar.gz")) {
        // Archive file: use as-is
        archivePath = resolvedPath;
      } else {
        console.error(errorText("Input must be a .tar.gz archive or a directory"));
        process.exit(1);
      }

      const archiveStats = statSync(archivePath);
      const archiveSizeKB = Math.round(archiveStats.size / 1024);

      console.log(`${label('Archive:')} ${value(archivePath)}`);
      console.log(`${label('Size:')} ${value(`${archiveSizeKB} KB`)}`);
      console.log();

      if (dryRun) {
        console.log(warnBanner("Dry run - no data will be uploaded"));
        console.log(`Would upload to: ${normalizeUrl(url)}${getApiBasePath()}/runs/upload`);
        
        // Cleanup temp dir if created
        if (tempDir) {
          rmSync(tempDir, { recursive: true, force: true });
        }
        return;
      }

      // Upload archive
      console.log(`${label('Uploading to')} ${value(normalizeUrl(url))}...`);
      
      const formData = new FormData();
      const archiveBuffer = readFileSync(archivePath);
      const blob = new Blob([archiveBuffer], { type: "application/gzip" });
      formData.append("archive", blob, basename(archivePath));

      const response = await apiFetch(url, `/runs/upload`, {
        method: "POST",
        body: formData,
        projectId: requireProjectId(options.project),
      });

      // Cleanup temp dir if created
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: response.statusText }));
        
        if (response.status === 409) {
          console.error(errorText(`Error: ${errorData.error || "Run already exists"}`));
        } else if (response.status === 400) {
          console.error(errorText(`Error: ${errorData.error || "Invalid archive"}`));
        } else {
          console.error(errorText(`Error: ${errorData.error || response.statusText}`));
        }
        process.exit(1);
      }

      const result = await response.json();
      console.log();
      console.log(successText("Run uploaded successfully!"));
      console.log(`${label('Run ID:')} ${value(result.id)}`);
      console.log(`${label('Status:')} ${value(result.status)}`);
      console.log(`${label('Iterations:')} ${value(String(result.iterations))}`);

    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

run
  .command("upload-batch")
  .description("Upload a batch run archive (multiple runs in one .tar.gz, as produced by 'run download-batch')")
  .argument("<path>", "Path to batch .tar.gz archive")
  .option("--dry-run", "Preview what would be uploaded without sending")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (inputPath: string, options) => {
    const { url, dryRun } = options;

    try {
      const resolvedPath = resolve(inputPath);
      if (!existsSync(resolvedPath)) {
        console.error(errorText(`Path not found: ${resolvedPath}`));
        process.exit(1);
      }
      if (!resolvedPath.endsWith(".tar.gz")) {
        console.error(errorText("Input must be a .tar.gz batch archive"));
        process.exit(1);
      }

      const archiveStats = statSync(resolvedPath);
      const archiveSizeKB = Math.round(archiveStats.size / 1024);

      console.log(`${label('Archive:')} ${value(resolvedPath)}`);
      console.log(`${label('Size:')} ${value(`${archiveSizeKB} KB`)}`);
      console.log();

      if (dryRun) {
        console.log(warnBanner("Dry run - no data will be uploaded"));
        console.log(`Would upload to: ${normalizeUrl(url)}${getApiBasePath()}/runs/upload-batch`);
        return;
      }

      console.log(`${label('Uploading to')} ${value(normalizeUrl(url))}...`);

      const formData = new FormData();
      const archiveBuffer = readFileSync(resolvedPath);
      const blob = new Blob([archiveBuffer], { type: "application/gzip" });
      formData.append("archive", blob, basename(resolvedPath));

      const response = await apiFetch(url, `/runs/upload-batch`, {
        method: "POST",
        body: formData,
        projectId: requireProjectId(options.project),
      });

      // 201 = all imported, 207 = partial, 400 = none / bad input
      if (response.status === 400) {
        const errorData = await response.json().catch(() => ({ error: response.statusText }));
        console.error(errorText(`Error: ${errorData.error || response.statusText}`));
        process.exit(1);
      }

      const result = await response.json() as {
        imported: { id: string; status: string; iterations: number }[];
        failed: { id?: string; error: string; statusCode: number }[];
      };

      console.log();
      if (result.imported.length > 0) {
        console.log(successText(`Imported ${result.imported.length} run(s):`));
        for (const r of result.imported) {
          console.log(`  ${value(r.id)} — ${r.status} (${r.iterations} iter)`);
        }
      }
      if (result.failed.length > 0) {
        console.log();
        console.log(warnBanner(`${result.failed.length} run(s) failed:`));
        for (const f of result.failed) {
          console.log(`  ${errorText(f.id ?? '<unknown>')} — [${f.statusCode}] ${f.error}`);
        }
        // Exit non-zero on partial failure so CI / scripts notice.
        process.exit(1);
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Run-retry-attempts (issue #658) ──────────────────────────────────────

run
  .command("retry")
  .description("Retry a request — starts a new attempt while preserving previous attempts in history")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-f, --force", "Allow retrying a successful run")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    const { id, force } = options;
    try {
      const response = await apiFetch(options.url, `/requests/${id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: force ? JSON.stringify({ force: true }) : undefined,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: response.statusText }));
        if (response.status === 422) {
          console.error(errorText(`Cannot retry: ${errorData.error}`));
        } else if (response.status === 409) {
          console.error(errorText(`Conflict: ${errorData.error}`));
        } else if (response.status === 404) {
          console.error(errorText(`Not found: ${errorData.error}`));
        } else {
          console.error(errorText(`Error: ${errorData.error || response.statusText}`));
        }
        process.exit(1);
      }
      const result = await response.json();
      console.log(successText("Retry started"));
      console.log(`${label('Request ID:')} ${value(result.requestId)}`);
      console.log(`${label('New run ID:')} ${value(result.runId)}`);
      console.log(`${label('Attempt:')} ${value(String(result.attemptNumber))}`);
      printFollowUpCommands(result.requestId);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
run
  .command("attempts")
  .description("List all attempts for a request (current + history)")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const { id } = options;
    try {
      const response = await apiFetch(options.url, `/requests/${id}/runs`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: response.statusText }));
        console.error(errorText(`Error: ${errorData.error || response.statusText}`));
        process.exit(1);
      }
      const attempts = await response.json() as Array<Record<string, unknown>>;

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'attemptNumber', label: 'Attempt' },
          { key: '_id', label: 'Run ID' },
          { key: 'status', label: 'Status' },
          { key: 'outcome', label: 'Outcome' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData(attempts, fields, format));
        return;
      }

      console.log(`${label('Request:')} ${value(id)}`);
      console.log(`${label('Total attempts:')} ${value(String(attempts.length))}`);
      console.log();
      for (const a of attempts) {
        const isCurrent = a === attempts[0];
        const marker = isCurrent ? "* " : "  ";
        const status = a.status as string;
        const outcome = a.outcome as string | undefined;
        console.log(
          `${marker}${label(`Attempt ${a.attemptNumber}:`)} ${value(String(a._id))} ${value(status)}${outcome ? ` / ${value(outcome)}` : ''}${a.updatedAt ? ` (${a.updatedAt})` : ''}`,
        );
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

}
