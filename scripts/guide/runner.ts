// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// runner.ts — Run a recipe's pnpm steps in order
// =============================================================================
// Each step runs as `pnpm <args>` with the terminal handed over to the child.
// The guide stops at the first failing step and reports the child's exit code.
// =============================================================================

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { formatStep, type Recipe, type RecipeStep } from "./catalog.js";

/** Starts one `pnpm` process and resolves with its exit code. */
export type StepSpawner = (pnpmArgs: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>;

/** Options for {@link runRecipe}. */
export interface RunOptions {
  /** Repository root; every step runs from here. */
  cwd: string;
  /** Environment for the child processes (e.g. process.env plus a consented GITHUB_TOKEN). */
  env: NodeJS.ProcessEnv;
  /** Called before each step starts, e.g. to print a progress line. */
  onStep?: (recipeStep: RecipeStep, index: number, total: number) => void;
  /** Process launcher (default: {@link spawnPnpm}); injectable for tests. */
  spawnStep?: StepSpawner;
}

/** Outcome of a recipe run. */
export interface RunResult {
  /** 0 when every step succeeded, otherwise the failing step's exit code. */
  exitCode: number;
  /** The step that failed, if any. */
  failedStep?: RecipeStep;
}

/** Convert a child's exit status into a shell-style exit code (128 + signal number for signals). */
export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) return 128 + (constants.signals[signal] ?? 0);
  return 1;
}

/**
 * Run `pnpm` with inherited stdio. While the child runs, the guide ignores
 * Ctrl+C: the terminal delivers SIGINT to the child too, and the guide must
 * outlive it to report the result instead of exiting mid-shutdown.
 */
export const spawnPnpm: StepSpawner = (pnpmArgs, { cwd, env }) =>
  new Promise((resolve) => {
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);

    // pnpm is a .cmd shim on Windows, which needs a shell to launch.
    const child = spawn("pnpm", pnpmArgs, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });

    child.on("error", (error) => {
      process.off("SIGINT", ignoreInterrupt);
      process.stderr.write(`Could not start pnpm: ${error.message}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignoreInterrupt);
      resolve(exitCodeOf(code, signal));
    });
  });

/** Run every step of a recipe in order, stopping at the first failure. */
export async function runRecipe(recipe: Recipe, options: RunOptions): Promise<RunResult> {
  const spawnStep = options.spawnStep ?? spawnPnpm;

  for (const [index, recipeStep] of recipe.steps.entries()) {
    options.onStep?.(recipeStep, index, recipe.steps.length);

    const exitCode = await spawnStep(recipeStep.pnpm, { cwd: options.cwd, env: options.env });
    if (exitCode !== 0) return { exitCode, failedStep: recipeStep };
  }

  return { exitCode: 0 };
}

/** Describe a failed run for the user, including the exact command that failed. */
export function describeFailure(result: RunResult): string | undefined {
  if (!result.failedStep) return undefined;
  return `${formatStep(result.failedStep)} exited with code ${result.exitCode}.`;
}
