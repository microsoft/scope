// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// main.ts — Interactive contributor guide (`pnpm start` / `pnpm scope`)
// =============================================================================
// Asks a few questions, resolves them to a recipe of existing pnpm scripts,
// checks prerequisites, shows the exact commands, and runs them only after
// the user confirms.
//
// Usage:
//   pnpm start               # guided menu (alias: pnpm scope)
//   pnpm start --list        # print every command, grouped by topic
//   pnpm start --dry-run     # walk through the questions without running anything
// =============================================================================

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  findRecipe,
  formatRecipeCommand,
  formatStep,
  groupByCategory,
  otherScriptRecipes,
  RECIPES,
  type Caution,
  type Recipe,
} from "./catalog.js";
import { readLastRecipeId, writeLastRecipeId } from "./history.js";
import { createStyle, Prompter, type Style } from "./prompt.js";
import { checkRequirements, createCheckContext, type CheckContext, type CheckResult } from "./requirements.js";
import { describeFailure, runRecipe, type RunResult } from "./runner.js";
import { buildTree, describeChoice, ROOT_NODE, type DecisionNode } from "./tree.js";

/** Repository root; every command runs from here. */
export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Exit code a shell reports for a process interrupted with Ctrl+C. */
const INTERRUPTED = 130;

export const USAGE = `Usage: pnpm start [options]        (alias: pnpm scope)

Answer a few questions to find the right pnpm command for your task. The guide
checks prerequisites, shows the exact commands, and runs them after you confirm.

Options:
  --list      Print every command, grouped by topic, and exit
  --dry-run   Go through the questions and checks, but only print the commands
  -h, --help  Show this help
`;

/** Parsed command-line options. */
export interface GuideArgs {
  list: boolean;
  dryRun: boolean;
  help: boolean;
}

/**
 * Parse the guide's options. A bare `--` (as forwarded by some pnpm versions)
 * is ignored.
 *
 * @throws When an unknown option or positional argument is passed.
 */
export function parseGuideArgs(argv: string[]): GuideArgs {
  const { values } = parseArgs({
    args: argv.filter((argument) => argument !== "--"),
    options: {
      list: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return { list: values.list, dryRun: values["dry-run"], help: values.help };
}

/** Read the root package.json `scripts` map. */
export function readRootScripts(root: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  return manifest.scripts ?? {};
}

/** Curated recipes plus a fallback recipe for every other root script. */
export function allRecipes(scripts: Record<string, string>): Recipe[] {
  return [...RECIPES, ...otherScriptRecipes(scripts, RECIPES)];
}

const CAUTION_TAGS: Record<Caution, string> = {
  destructive: "deletes data",
  "spends-credits": "spends provider credits",
  experimental: "experimental",
};

const CAUTION_BANNERS: Record<Caution, string> = {
  destructive: "Destructive: this deletes data or files.",
  "spends-credits": "Spends provider credits: coding agents or model calls consume quota and may incur charges.",
  experimental: "Experimental: not yet validated end to end.",
};

/** Render the `--list` catalog: every recipe grouped by topic, with its exact command. */
export function formatList(recipes: readonly Recipe[], style: Style): string {
  const lines = [`${style.bold("Scope contributor commands")} ${style.dim("(run pnpm start for a guided walkthrough)")}`];

  for (const group of groupByCategory(recipes)) {
    lines.push("", style.bold(group.title));

    // Fallback recipes are titled with the script name, so the command says it all.
    for (const recipe of group.recipes) {
      if (group.id === "other") {
        lines.push(`  ${formatRecipeCommand(recipe)}`);
        continue;
      }
      const tag = recipe.caution ? style.yellow(` [${CAUTION_TAGS[recipe.caution]}]`) : "";
      lines.push(`  ${recipe.title}${tag}`, `    ${style.cyan(formatRecipeCommand(recipe))}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Everything the interactive flow needs; injected so tests can script it. */
export interface GuideSession {
  prompter: Pick<Prompter, "select" | "confirm" | "close">;
  /** Writes user-facing output. */
  write: (text: string) => void;
  style: Style;
  recipes: readonly Recipe[];
  tree: ReadonlyMap<string, DecisionNode>;
  checkContext: CheckContext;
  /** Show the plan but never run or remember it. */
  dryRun: boolean;
  /** Recipe id offered as "Run again", if any. */
  lastRecipeId?: string;
  saveLastRecipe: (recipeId: string) => void;
  /** Base environment for the commands. */
  env: NodeJS.ProcessEnv;
  run: (recipe: Recipe, env: NodeJS.ProcessEnv) => Promise<RunResult>;
}

/**
 * Walk the decision tree until the user picks a recipe. The root menu starts
 * with a "Run again" shortcut when history exists; `b` goes up one level.
 *
 * @returns The chosen recipe, or `undefined` if the user quit.
 */
export async function chooseRecipe(session: GuideSession): Promise<Recipe | undefined> {
  const lastRecipe = session.lastRecipeId ? findRecipe(session.recipes, session.lastRecipeId) : undefined;
  const path = [ROOT_NODE];

  for (;;) {
    const nodeId = path[path.length - 1];
    const node = session.tree.get(nodeId);
    if (!node) throw new Error(`Unknown guide question: ${nodeId}`);

    // Only the root menu offers the "Run again" shortcut, as its first, default option.
    const atRoot = path.length === 1;
    const shortcut = atRoot && lastRecipe ? [{ label: `Run again: ${lastRecipe.title}`, hint: formatRecipeCommand(lastRecipe) }] : [];
    const options = [...shortcut, ...node.choices.map((choice) => describeChoice(choice, session.recipes))];
    const recommended = node.choices.findIndex((choice) => choice.recommended);
    const defaultIndex = shortcut.length > 0 ? 0 : recommended >= 0 ? recommended : undefined;

    const selection = await session.prompter.select(node.question, options, { defaultIndex, allowBack: !atRoot });
    if (selection.kind === "quit") return undefined;
    if (selection.kind === "back") {
      path.pop();
      continue;
    }
    if (selection.index < shortcut.length) return lastRecipe;

    // Either descend into the next question or resolve the chosen recipe.
    const choice = node.choices[selection.index - shortcut.length];
    if ("node" in choice) {
      path.push(choice.node);
      continue;
    }
    const recipe = findRecipe(session.recipes, choice.recipe);
    if (!recipe) throw new Error(`Unknown guide recipe: ${choice.recipe}`);
    return recipe;
  }
}

/** Describe what a recipe does, with a caution banner when relevant. */
export function describeRecipe(recipe: Recipe, style: Style): string {
  const lines = ["", style.bold(recipe.title), recipe.summary];

  if (recipe.caution) {
    const color = recipe.caution === "destructive" ? style.red : style.yellow;
    lines.push(color(`⚠ ${CAUTION_BANNERS[recipe.caution]}`));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render one check result. Failures of recommended (non-blocking) checks are
 * shown as warnings.
 */
export function formatCheck(result: CheckResult, blocking: boolean, style: Style): string {
  const status = result.status === "fail" && !blocking ? "warn" : result.status;
  const symbol = { ok: style.green("✔"), warn: style.yellow("!"), fail: style.red("✖") }[status];

  const lines = [`  ${symbol} ${result.label}: ${result.detail}`];
  if (status !== "ok" && result.fix) lines.push(`      ${style.dim(result.fix)}`);
  return `${lines.join("\n")}\n`;
}

/** Outcome of the prerequisite step. */
interface RequirementOutcome {
  /** Whether the user wants to go ahead. */
  proceed: boolean;
  /** Variables the user agreed to pass to the commands (e.g. GITHUB_TOKEN from the GitHub CLI). */
  env: Record<string, string>;
}

/**
 * Check a recipe's prerequisites, offer credential fixes, and ask whether to
 * continue when a required prerequisite is still missing.
 */
export async function resolveRequirements(session: GuideSession, recipe: Recipe): Promise<RequirementOutcome> {
  const { write, style, prompter } = session;
  const required = new Set(recipe.requires ?? []);
  const ids = [...(recipe.requires ?? []), ...(recipe.recommends ?? [])];
  const outcome: RequirementOutcome = { proceed: true, env: {} };
  if (ids.length === 0) return outcome;

  write(`\n${style.bold("Checking prerequisites…")}\n`);
  const missing: CheckResult[] = [];

  for (const result of checkRequirements(ids, session.checkContext)) {
    const blocking = required.has(result.id);
    write(formatCheck(result, blocking, style));
    if (result.status !== "fail") continue;

    // A consented credential (never printed or stored) satisfies a required check for this run.
    if (blocking && result.offer && (await prompter.confirm(`    ${result.offer.question}`, true))) {
      const variables = result.offer.resolve();
      if (variables) {
        Object.assign(outcome.env, variables);
        write(`  ${style.green("✔")} ${result.label}: provided for this run only\n`);
        continue;
      }
      write(style.yellow(`    Could not obtain ${result.label}.\n`));
    }
    if (blocking) missing.push(result);
  }

  if (missing.length > 0) {
    write(style.yellow(`\nMissing: ${missing.map((result) => result.label).join(", ")}. The command will probably fail.\n`));
    outcome.proceed = await prompter.confirm("Continue anyway?", false);
  }
  return outcome;
}

/** Show the exact commands, in order, followed by what to do next. */
export function describePlan(recipe: Recipe, style: Style): string {
  const lines = ["", style.bold(recipe.steps.length === 1 ? "Command:" : "Commands, run in order (stops at the first failure):")];

  recipe.steps.forEach((recipeStep, index) => {
    const number = recipe.steps.length === 1 ? "" : `${index + 1}. `;
    const note = recipeStep.longRunning ? style.dim("  (keeps running until you press Ctrl+C)") : "";
    lines.push(`  ${number}${style.cyan(formatStep(recipeStep))}${note}`);
  });

  if (recipe.followUps?.length) {
    lines.push("", style.bold("Next steps:"), ...recipe.followUps.map((followUp) => `  • ${followUp}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Report how the run ended and teach the direct command. */
function describeResult(recipe: Recipe, result: RunResult, style: Style): { message: string; exitCode: number } {
  const tip = style.dim(`Next time, run it directly: ${formatRecipeCommand(recipe)}`);

  // Stopping a dev server with Ctrl+C is the normal way to end it, not a failure.
  if (result.failedStep?.longRunning && result.exitCode === INTERRUPTED) {
    return { message: `\nStopped.\n${tip}\n`, exitCode: 0 };
  }
  if (result.failedStep) {
    return { message: `\n${style.red(`✖ ${describeFailure(result)}`)}\n${tip}\n`, exitCode: result.exitCode };
  }
  return { message: `\n${style.green("✔ Done.")}\n${tip}\n`, exitCode: 0 };
}

/**
 * Run the interactive flow: choose → explain → check → plan → confirm → run.
 *
 * @returns The process exit code (0 when the user quits or declines).
 */
export async function runGuide(session: GuideSession): Promise<number> {
  const { write, style, prompter } = session;

  const recipe = await chooseRecipe(session);
  if (!recipe) {
    write("Nothing was run.\n");
    return 0;
  }

  write(describeRecipe(recipe, style));
  const requirements = await resolveRequirements(session, recipe);
  if (!requirements.proceed) {
    write("Nothing was run.\n");
    return 0;
  }

  write(describePlan(recipe, style));
  if (session.dryRun) {
    write(style.dim("\nDry run: nothing was executed.\n"));
    return 0;
  }

  // Destructive recipes require an explicit "y".
  write("\n");
  if (!(await prompter.confirm("Run it now?", recipe.caution !== "destructive"))) {
    write(`Nothing was run. To run it later: ${formatRecipeCommand(recipe)}\n`);
    return 0;
  }

  // Hand the terminal to the commands.
  session.saveLastRecipe(recipe.id);
  prompter.close();
  write("\n");
  const result = await session.run(recipe, { ...session.env, ...requirements.env });

  const { message, exitCode } = describeResult(recipe, result, style);
  write(message);
  return exitCode;
}

/**
 * Entry point. Prints the catalog instead of prompting when stdin or stdout is
 * not a terminal (CI, pipes), so the guide never hangs waiting for input.
 *
 * @returns The process exit code.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const write = (text: string) => process.stdout.write(text);

  let args: GuideArgs;
  try {
    args = parseGuideArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    write(USAGE);
    return 0;
  }

  const style = createStyle();
  const recipes = allRecipes(readRootScripts(ROOT));

  if (args.list) {
    write(formatList(recipes, style));
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    write(formatList(recipes, style));
    write(style.dim("\nRun pnpm start in an interactive terminal to be guided step by step.\n"));
    return 0;
  }

  write(`${style.bold("Scope contributor guide")}\n${style.dim("Answer a few questions to find the right command. Nothing runs until you confirm.")}\n`);
  const prompter = new Prompter(process.stdin, process.stdout, style);

  try {
    return await runGuide({
      prompter,
      write,
      style,
      recipes,
      tree: buildTree(recipes),
      checkContext: createCheckContext(ROOT),
      dryRun: args.dryRun,
      lastRecipeId: readLastRecipeId(ROOT),
      saveLastRecipe: (recipeId) => writeLastRecipeId(ROOT, recipeId),
      env: process.env,
      run: (recipe, env) =>
        runRecipe(recipe, {
          cwd: ROOT,
          env,
          onStep: (recipeStep, index, total) => {
            if (total > 1) write(style.bold(`\n▶ [${index + 1}/${total}] ${formatStep(recipeStep)}\n`));
          },
        }),
    });
  } finally {
    prompter.close();
  }
}

// Allow `tsx scripts/guide/main.ts` in addition to the launcher.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
