#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// launch.mjs — Entry point for `pnpm start` / `pnpm scope`
// =============================================================================
// Plain JavaScript with no dependencies, so it also works on a fresh clone:
// when tsx is not installed yet it offers to run `pnpm install` first, then
// runs the TypeScript guide (main.ts) through tsx's loader.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installArgs = ["install", "--frozen-lockfile"];

/**
 * Ask a yes/no question that defaults to yes.
 *
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function confirm(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

/** Run `pnpm install --frozen-lockfile` in the repository root and resolve with its exit code. */
function install() {
  return new Promise((resolve) => {
    const child = spawn("pnpm", installArgs, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Make sure tsx is installed, offering to install dependencies when it is not.
 *
 * @returns Whether the guide can start.
 */
async function ensureDependencies() {
  if (existsSync(join(root, "node_modules", "tsx", "package.json"))) return true;

  console.log("Workspace dependencies are not installed yet.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`Run pnpm ${installArgs.join(" ")}, then pnpm start.`);
    return false;
  }
  if (!(await confirm(`Run pnpm ${installArgs.join(" ")} now?`))) return false;

  return (await install()) === 0;
}

/**
 * Run main.ts with tsx's loader and resolve with its exit code. Ctrl+C reaches
 * the guide and its commands directly, so the launcher ignores it and waits.
 *
 * @param {string[]} args - Options forwarded to the guide.
 * @returns {Promise<number>}
 */
function runGuide(args) {
  return new Promise((resolve) => {
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);

    const child = spawn(process.execPath, ["--import", "tsx", join(root, "scripts", "guide", "main.ts"), ...args], { cwd: root, stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`Could not start the guide: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignoreInterrupt);
      resolve(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}

process.exitCode = (await ensureDependencies()) ? await runGuide(process.argv.slice(2)) : 1;
