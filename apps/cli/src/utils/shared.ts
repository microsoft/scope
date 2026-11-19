// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { dimTimestamp, label, value } from "./style.js";
import { generateOutputFormatsHelp } from "./helpFormatter.js";

/** Require an explicitly configured API URL before constructing a request. */
export function normalizeUrl(url: string | undefined): string {
  const configured = url?.trim();
  if (!configured) {
    throw new Error("No API URL configured. Set SCOPE_API_URL or pass -u/--url (MCP server create/update: --api-url).");
  }
  return configured.replace(/\/+$/, "");
}

/**
 * Detect how the CLI was invoked and return the appropriate command prefix.
 * - Bundled binary (SCOPE_CLI_VERSION injected at build time): "scope"
 * - Development via tsx/pnpm (no build-time injection): "pnpm cli"
 */
export function getCliName(): string {
  // In bundled mode, esbuild replaces process.env.SCOPE_CLI_VERSION with a literal string.
  // In dev mode, it remains undefined (read from actual env which is unset).
  if (process.env.SCOPE_CLI_VERSION !== undefined) {
    return "scope";
  }
  return "pnpm cli";
}

export function printFollowUpCommands(id: string): void {
  const cli = getCliName();
  console.log(`\n${label('Run ID:')} ${value(id)}`);
  console.log(`\n${label('Next steps:')}`);
  console.log(`  ${dimTimestamp('Get details:')}   ${cli} run get -i ${id}`);
  console.log(`  ${dimTimestamp('Check status:')}  ${cli} run status -i ${id}`);
  console.log(`  ${dimTimestamp('Stream logs:')}   ${cli} run logs -i ${id}`);
  console.log(`  ${dimTimestamp('Download:')}      ${cli} run download -i ${id}`);
  console.log(`  ${dimTimestamp('List all runs:')} ${cli} run list`);
}

/** Read explicit environment configuration after dotenv has loaded. */
export function getDefaultApiUrl(): string | undefined {
  return process.env.SCOPE_API_URL?.trim() || undefined;
}

// Environment variable definitions surfaced in `--help`
export const ENV_VARS = {
  SCOPE_API_URL: {
    description: 'API base URL. Required for API operations unless -u/--url is supplied; there is no default.',
  },
  SCOPE_MT_DOWNLOAD_OUTPUT_DIR: {
    description: 'Default download directory for `run get` / `run watch` when --download-output-dir is omitted',
  },
  SCOPE_PROJECT: {
    description: 'Project ID used to scope commands when --project is omitted. Overridden by --project; overrides the saved `project use` selection. Required (via one of these) for scoped lists and creates — there is no default project.',
  },
} as const;

// Output format definitions with descriptions and categories
export const OUTPUT_FORMATS = {
  table: { section: 'Human-readable formats', description: 'Formatted table with borders (default for lists)' },
  tsv:   { section: 'Machine-readable formats', description: 'Tab-separated values for Unix tools (cut, awk, grep, xargs)' },
  json:  { section: 'Machine-readable formats', description: 'JSON format for programmatic access and AI agents' },
  yaml:  { section: 'Machine-readable formats', description: 'YAML format for human-friendly structured data' },
} as const;

/**
 * Add the standard `-o, --output <format>` option to a command.
 * @param cmd - The Commander command to add the option to.
 * @param extra - Additional format names beyond the defaults (table, tsv, json, yaml).
 * @returns The command (for chaining).
 */
export function withOutputOption(cmd: Command, extra?: string[]): Command {
  const formats = ['table', 'tsv', 'json', 'yaml', ...(extra ?? [])];
  return cmd.option("-o, --output <format>", `Output format: ${formats.join(', ')}`, "table");
}

/**
 * Add the standard `--project <id>` option to a scoped command. No short flag is
 * assigned to avoid colliding with per-command shorthands (e.g. `-p`).
 *
 * The option only *carries* an override — commands resolve the effective project
 * via {@link file://./config.ts resolveProjectId}/`requireProjectId`, which falls
 * back to `SCOPE_PROJECT` then the saved `project use` selection. There is no
 * default project, so scoped lists/creates error when none resolves.
 *
 * @param cmd - The Commander command to add the option to.
 * @returns The command (for chaining).
 */
export function withProjectOption(cmd: Command): Command {
  return cmd.option(
    "--project <id>",
    "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)",
  );
}
