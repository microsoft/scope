#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { configureHelp, generateOutputFormatsHelp, generateEnvVarsHelp } from "./utils/helpFormatter.js";
import { OUTPUT_FORMATS, ENV_VARS, applyApiPortFallback, getCliName } from "./utils/shared.js";
import { registerRunCommands } from "./commands/run.js";
import { registerCriteriaCommands } from "./commands/criteria.js";
import { registerPromptFeatureCommands } from "./commands/prompt-feature.js";
import { registerReportCommands } from "./commands/report.js";
import { registerReportTemplateCommands } from "./commands/report-template.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerCodebaseCommands } from "./commands/codebase.js";
import { registerResourceCommands } from "./commands/resource.js";
import { registerExtensionCommands } from "./commands/extension.js";
import { registerInsightCommands } from "./commands/insight.js";
import { registerTaskPromptCommands } from "./commands/task-prompt.js";
import { registerProfileCommands } from "./commands/profile.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerUpdateCommand } from "./commands/update.js";
import { checkForUpdates } from "./utils/update-check.js";
import { errorText } from "./utils/style.js";

// Version is injected at build time by esbuild; falls back for dev mode
const CLI_VERSION = process.env.SCOPE_CLI_VERSION ?? "0.1.0-dev";

/**
 * Walk up from `start` looking for a `.env` file, stopping at the first hit
 * or at the filesystem root. Lets `pnpm cli ...` (which sets cwd to apps/cli)
 * still pick up the workspace-root `.env` produced by `worktree-env`, where
 * variables like SCOPE_API_PORT actually live.
 */
function findEnvFile(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const envPath = findEnvFile(process.cwd());
dotenv.config(envPath ? { path: envPath } : undefined);

// If SCOPE_API_URL is not already set but SCOPE_API_PORT is (e.g. when the API
// is running locally on a non-default port via docker-compose), derive a
// default SCOPE_API_URL of http://localhost:$SCOPE_API_PORT. Must run before
// any command module captures `process.env.SCOPE_API_URL` as its option
// default.
applyApiPortFallback();

export const program = new Command();

program
  .name(getCliName())
  .description("Scope — The AI Agentic Experience Evaluation Platform")
  .version(CLI_VERSION)
  .action(() => {
    program.help();
  })
  .addHelpText('after', generateOutputFormatsHelp(OUTPUT_FORMATS))
  .addHelpText('after', generateEnvVarsHelp(ENV_VARS));

configureHelp(program);

// Register all command groups
registerProjectCommands(program);
registerRunCommands(program);
registerCriteriaCommands(program);
registerPromptFeatureCommands(program);
registerReportCommands(program);
registerReportTemplateCommands(program);
registerAgentCommands(program);
registerMcpCommands(program);
registerSkillCommands(program);
registerCodebaseCommands(program);
registerResourceCommands(program);
registerExtensionCommands(program);
registerInsightCommands(program);
registerTaskPromptCommands(program);
registerProfileCommands(program);
registerUpdateCommand(program);

// Only parse when run directly (not when imported by tests)
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const runFile = realpathSync(process.argv[1]);
    return thisFile === runFile;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const flushUpdateCheck = checkForUpdates(CLI_VERSION);
  try {
    await program.parseAsync();
  } catch (error) {
    console.error(errorText("Error:"), error instanceof Error ? error.message : error);
    await flushUpdateCheck();
    process.exit(1);
  }
  await flushUpdateCheck();
}
