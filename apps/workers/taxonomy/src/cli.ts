#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Taxonomy post-processor developer CLI.
 *
 * Invokes the taxonomy generation loop directly against an existing requestId,
 * streams the Copilot SDK session events live, and saves the validated taxonomy
 * to a local JSON file. This is a developer/troubleshooting tool only — it never
 * writes to Mongo (handlerStatus) or blob storage (taxonomy.json) and does not
 * notify the scheduler.
 *
 * Usage:
 *   npx tsx src/cli.ts <requestId> [options]
 *   pnpm taxonomy <requestId> [options]
 *
 * Options:
 *   --run, -r <runId>     Run id for the prompt/logging (default: active run from API).
 *   --model <model>       Override TAXONOMY_MODEL (e.g. a reasoning model).
 *   --timeout <ms>        Override SESSION_TIMEOUT_MS (per-attempt session timeout).
 *   --output, -o <file>   Output file path (default: taxonomy-<requestId>.json).
 *   --stdout              Also print the taxonomy JSON to stdout.
 *   --quiet               Suppress live session-event streaming on stderr.
 *   --help, -h            Show this help.
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionEvent } from "@github/copilot-sdk";
import { TokenManagerClient, type LogEvent, type RequestDocument } from "shared";
import { generateTaxonomy } from "./taxonomy-generator.js";

interface CliArgs {
  requestId: string;
  runId?: string;
  model?: string;
  timeoutMs?: number;
  output?: string;
  stdout: boolean;
  quiet: boolean;
}

function printHelp(): void {
  process.stderr.write(
    [
      "Taxonomy post-processor developer CLI",
      "",
      "Usage: npx tsx src/cli.ts <requestId> [options]",
      "",
      "Options:",
      "  --run, -r <runId>     Run id for the prompt/logging (default: active run from API)",
      "  --model <model>       Override TAXONOMY_MODEL",
      "  --timeout <ms>        Override SESSION_TIMEOUT_MS (per-attempt session timeout)",
      "  --output, -o <file>   Output file path (default: taxonomy-<requestId>.json)",
      "  --stdout              Also print the taxonomy JSON to stdout",
      "  --quiet               Suppress live session-event streaming on stderr",
      "  --help, -h            Show this help",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliArgs | undefined {
  const args: Partial<CliArgs> & { stdout: boolean; quiet: boolean } = { stdout: false, quiet: false };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        return undefined;
      case "--run":
      case "-r":
        args.runId = argv[++i];
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--timeout":
        args.timeoutMs = Number(argv[++i]);
        break;
      case "--output":
      case "-o":
        args.output = argv[++i];
        break;
      case "--stdout":
        args.stdout = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positionals.push(arg);
    }
  }

  const requestId = positionals[0];
  if (!requestId) {
    throw new Error("Missing required <requestId> argument");
  }
  if (args.timeoutMs !== undefined && Number.isNaN(args.timeoutMs)) {
    throw new Error("--timeout must be a number (milliseconds)");
  }

  return { ...args, requestId };
}

async function resolveRunId(apiBaseUrl: string, requestId: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
    if (response.ok) {
      const request: RequestDocument = await response.json();
      if (request.run?._id) return request.run._id;
    }
  } catch {
    // fall through to requestId fallback
  }
  return requestId;
}

function summarizeEvent(event: SessionEvent): string | undefined {
  switch (event.type) {
    case "session.start":
      return `session.start model=${event.data.selectedModel}`;
    case "session.error":
      return `session.error ${event.data.errorType}: ${event.data.message}`;
    case "tool.execution_start":
      return `tool.start ${event.data.toolName} ${JSON.stringify(event.data.arguments ?? {})}`;
    case "tool.execution_complete":
      return `tool.done ${event.data.success ? "ok" : "FAILED"}${event.data.error ? ` ${event.data.error.message}` : ""}`;
    case "assistant.message":
      return `assistant.message (${event.data.content.length} chars)`;
    default:
      return undefined;
  }
}

async function main(): Promise<void> {
  let parsed: CliArgs | undefined;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n\n`);
    printHelp();
    process.exit(2);
  }
  if (!parsed) return; // help shown

  const apiBaseUrl = process.env.SCOPE_MT_API_URL || "http://localhost:3001";
  const taxonomyModel = parsed.model || process.env.TAXONOMY_MODEL || "gpt-5.4";
  const sessionTimeoutMs = parsed.timeoutMs ?? (Number(process.env.SESSION_TIMEOUT_MS) || 5 * 60 * 1000);
  const outputPath = resolve(parsed.output ?? `taxonomy-${parsed.requestId}.json`);

  const githubToken = process.env.GITHUB_TOKEN
    ? process.env.GITHUB_TOKEN
    : await new TokenManagerClient(process.env.TOKEN_MANAGER_URL).acquireToken("copilot-sdk");

  const runId = await resolveRunId(apiBaseUrl, parsed.requestId, parsed.runId);

  const log = (level: LogEvent["level"], msg: string, data?: Record<string, unknown>): void => {
    if (parsed.quiet) return;
    const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
    process.stderr.write(`[${level}] ${msg}${suffix}\n`);
  };

  process.stderr.write(
    `Generating taxonomy: requestId=${parsed.requestId} runId=${runId} model=${taxonomyModel} timeout=${sessionTimeoutMs}ms\n`,
  );

  const onEvent = parsed.quiet
    ? undefined
    : (event: SessionEvent): void => {
        const summary = summarizeEvent(event);
        if (summary) process.stderr.write(`  · ${summary}\n`);
      };

  const taxonomy = await generateTaxonomy({
    requestId: parsed.requestId,
    runId,
    apiBaseUrl,
    taxonomyModel,
    githubToken,
    sessionTimeoutMs,
    log,
    onEvent,
  });

  const json = JSON.stringify(taxonomy, null, 2);
  await writeFile(outputPath, `${json}\n`, "utf-8");
  process.stderr.write(`\nTaxonomy written to ${outputPath}\n`);
  if (parsed.stdout) {
    process.stdout.write(`${json}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`\nTaxonomy generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
