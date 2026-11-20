// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { Recipe } from "./catalog.js";
import { allRecipes, formatList, parseGuideArgs, readRootScripts, ROOT, runGuide, type GuideSession } from "./main.js";
import { createStyle, type Selection } from "./prompt.js";
import type { CheckContext } from "./requirements.js";
import type { RunResult } from "./runner.js";
import { buildTree } from "./tree.js";

const recipes = allRecipes(readRootScripts(ROOT));
const plain = createStyle(false);

/** Every tool installed and every credential present, unless overridden. */
function healthyMachine(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    env: { GITHUB_TOKEN: "present", ANTHROPIC_API_KEY: "present", SCOPE_DIND_SPIKE: "1" },
    nodeVersion: "22.22.0",
    onPath: () => true,
    succeeds: () => true,
    output: () => undefined,
    readFile: (path) => (path === ".env" ? "" : undefined),
    ...overrides,
  };
}

/** Menu answers: 1-based numbers, "b" for back, "q" for quit. */
type MenuAnswer = number | "b" | "q";

/**
 * A guide session driven by scripted menu and yes/no answers. Records what was
 * printed, which confirmations were asked (with their defaults), what ran, and
 * what was remembered.
 */
function scriptedSession(options: {
  menu: MenuAnswer[];
  confirms?: boolean[];
  checkContext?: CheckContext;
  dryRun?: boolean;
  lastRecipeId?: string;
  runResult?: RunResult;
}) {
  const menu = [...options.menu];
  const confirms = [...(options.confirms ?? [])];
  const record = {
    output: "",
    questions: [] as string[],
    confirmQuestions: [] as Array<{ question: string; defaultValue: boolean }>,
    ran: [] as Array<{ recipe: Recipe; env: NodeJS.ProcessEnv }>,
    saved: [] as string[],
    closed: false,
  };

  const session: GuideSession = {
    prompter: {
      select: async (question): Promise<Selection> => {
        record.questions.push(question);
        const answer = menu.shift() ?? "q";
        if (answer === "q") return { kind: "quit" };
        if (answer === "b") return { kind: "back" };
        return { kind: "choice", index: answer - 1 };
      },
      confirm: async (question, defaultValue) => {
        record.confirmQuestions.push({ question: question.trim(), defaultValue });
        return confirms.shift() ?? defaultValue;
      },
      close: () => {
        record.closed = true;
      },
    },
    write: (text) => {
      record.output += text;
    },
    style: plain,
    recipes,
    tree: buildTree(recipes),
    checkContext: options.checkContext ?? healthyMachine(),
    dryRun: options.dryRun ?? false,
    lastRecipeId: options.lastRecipeId,
    saveLastRecipe: (recipeId) => record.saved.push(recipeId),
    env: { BASE: "1" },
    run: async (recipe, env) => {
      record.ran.push({ recipe, env });
      return options.runResult ?? { exitCode: 0 };
    },
  };
  return { session, record };
}

describe("parseGuideArgs", () => {
  it("parses flags and ignores a bare -- forwarded by pnpm", () => {
    expect(parseGuideArgs([])).toEqual({ list: false, dryRun: false, help: false });
    expect(parseGuideArgs(["--", "--list", "--dry-run", "-h"])).toEqual({ list: true, dryRun: true, help: true });
  });

  it("rejects unknown options and positional arguments", () => {
    expect(() => parseGuideArgs(["--bogus"])).toThrow();
    expect(() => parseGuideArgs(["docker"])).toThrow();
  });
});

describe("formatList", () => {
  it("lists curated recipes with their commands, cautions, and the remaining scripts", () => {
    const list = formatList(recipes, plain);

    expect(list).toContain("Run Scope locally");
    expect(list).toContain("Full stack with the GitHub Copilot worker [spends provider credits]\n    pnpm docker:dev:copilot");
    expect(list).toContain("pnpm docker:down");
    expect(list).toContain("Other scripts");
    expect(list).toContain("  pnpm docker:up:auth");
    expect(list).not.toMatch(/^\s+pnpm (start|scope)$/m);
  });
});

describe("runGuide", () => {
  it("walks Run → Docker Compose → Copilot, shows the plan, then runs and remembers it", async () => {
    // Root menu: 2 = Run Scope locally; then 1 = Docker Compose; then 1 = GitHub Copilot.
    const { session, record } = scriptedSession({ menu: [2, 1, 1], confirms: [true] });

    const exitCode = await runGuide(session);

    expect(exitCode).toBe(0);
    expect(record.questions).toEqual(["What would you like to do?", "How do you want to run Scope?", "Which coding-agent worker do you need?"]);
    expect(record.output).toContain("⚠ Spends provider credits");
    expect(record.output).toContain("✔ Docker: daemon running");
    expect(record.output).toContain("pnpm docker:dev:copilot  (keeps running until you press Ctrl+C)");
    expect(record.output).toContain("pnpm open:portal");

    // The terminal is released to the command, which runs with the base environment.
    expect(record.closed).toBe(true);
    expect(record.ran.map((run) => run.recipe.id)).toEqual(["compose-copilot"]);
    expect(record.ran[0].env).toEqual({ BASE: "1" });
    expect(record.saved).toEqual(["compose-copilot"]);
    expect(record.output).toContain("Next time, run it directly: pnpm docker:dev:copilot");
  });

  it("goes back to the previous question with b", async () => {
    // Run Scope locally → back → Run tests → Unit tests.
    const { session, record } = scriptedSession({ menu: [2, "b", 4, 1], confirms: [true] });

    await runGuide(session);

    expect(record.questions).toEqual(["What would you like to do?", "How do you want to run Scope?", "What would you like to do?", "Which tests do you want to run?"]);
    expect(record.ran.map((run) => run.recipe.id)).toEqual(["test-unit"]);
  });

  it("offers the last recipe first as Run again", async () => {
    const { session, record } = scriptedSession({ menu: [1], confirms: [true], lastRecipeId: "pr-check" });

    await runGuide(session);

    expect(record.ran.map((run) => run.recipe.id)).toEqual(["pr-check"]);
    expect(record.output).toContain("Commands, run in order (stops at the first failure):");
    expect(record.output).toContain("4. pnpm notice:check");
  });

  it("ignores history that points at a recipe that no longer exists", async () => {
    // Without the shortcut, choice 1 is "Get set up".
    const { session, record } = scriptedSession({ menu: [1], confirms: [true], lastRecipeId: "removed-recipe" });

    await runGuide(session);

    expect(record.ran.map((run) => run.recipe.id)).toEqual(["setup"]);
  });

  it("shows the plan but neither runs nor remembers anything in a dry run", async () => {
    const { session, record } = scriptedSession({ menu: [5, 1], dryRun: true });

    const exitCode = await runGuide(session);

    expect(exitCode).toBe(0);
    expect(record.output).toContain("pnpm lint");
    expect(record.output).toContain("Dry run: nothing was executed.");
    expect(record.ran).toEqual([]);
    expect(record.saved).toEqual([]);
  });

  it("does nothing when the user declines, and defaults destructive recipes to no", async () => {
    // Stop or clean up → Stop the Docker Compose stack and delete its data; accept the default.
    const { session, record } = scriptedSession({ menu: [7, 1] });

    const exitCode = await runGuide(session);

    expect(exitCode).toBe(0);
    expect(record.output).toContain("⚠ Destructive");
    expect(record.confirmQuestions.at(-1)).toEqual({ question: "Run it now?", defaultValue: false });
    expect(record.ran).toEqual([]);
    expect(record.output).toContain("To run it later: pnpm docker:down");
  });

  it("passes a consented GitHub CLI token to the command without printing it", async () => {
    // GITHUB_TOKEN is missing but gh is signed in; accept the offer, then run.
    const checkContext = healthyMachine({
      env: {},
      output: (command, args) => (command === "gh" && args.join(" ") === "auth token" ? "gho_secret" : undefined),
    });
    const { session, record } = scriptedSession({ menu: [2, 1, 1], confirms: [true, true], checkContext });

    await runGuide(session);

    expect(record.confirmQuestions[0].question).toContain("gh auth token");
    expect(record.output).toContain("GITHUB_TOKEN: provided for this run only");
    expect(record.output).not.toContain("gho_secret");
    expect(record.ran[0].env).toEqual({ BASE: "1", GITHUB_TOKEN: "gho_secret" });
  });

  it("stops when a required prerequisite is missing and the user does not continue", async () => {
    const checkContext = healthyMachine({ onPath: (command) => command !== "cargo" });
    // Check my changes → Yes, also run the Rust checks; decline "Continue anyway?".
    const { session, record } = scriptedSession({ menu: [5, 2], confirms: [false], checkContext });

    const exitCode = await runGuide(session);

    expect(exitCode).toBe(0);
    expect(record.output).toContain("✖ Rust (cargo): cargo is not installed");
    expect(record.output).toContain("Missing: Rust (cargo)");
    expect(record.confirmQuestions[0]).toEqual({ question: "Continue anyway?", defaultValue: false });
    expect(record.ran).toEqual([]);
  });

  it("never blocks on recommended prerequisites", async () => {
    // Get set up recommends mkcert and GITHUB_TOKEN but requires neither, so the
    // GitHub CLI token is not offered for pnpm install.
    const checkContext = healthyMachine({
      env: {},
      onPath: (command) => command !== "mkcert",
      output: (command) => (command === "gh" ? "gho_secret" : undefined),
    });
    const { session, record } = scriptedSession({ menu: [1], confirms: [true], checkContext });

    await runGuide(session);

    expect(record.output).toContain("! mkcert: mkcert is not installed");
    expect(record.output).toContain("! GITHUB_TOKEN: not set, but the GitHub CLI is signed in");
    expect(record.confirmQuestions.map((confirm) => confirm.question)).toEqual(["Run it now?"]);
    expect(record.ran.map((run) => run.recipe.id)).toEqual(["setup"]);
    expect(record.ran[0].env).toEqual({ BASE: "1" });
  });

  it("reports a failing step with its exit code", async () => {
    const { session, record } = scriptedSession({
      menu: [4, 1],
      confirms: [true],
      runResult: { exitCode: 1, failedStep: { pnpm: ["test"] } },
    });

    expect(await runGuide(session)).toBe(1);
    expect(record.output).toContain("✖ pnpm test exited with code 1.");
  });

  it("treats Ctrl+C on a long-running command as a normal stop", async () => {
    const { session, record } = scriptedSession({
      menu: [4, 2],
      confirms: [true],
      runResult: { exitCode: 130, failedStep: { pnpm: ["test:watch"], longRunning: true } },
    });

    expect(await runGuide(session)).toBe(0);
    expect(record.output).toContain("Stopped.");
  });

  it("exits quietly when the user quits", async () => {
    const { session, record } = scriptedSession({ menu: ["q"] });

    expect(await runGuide(session)).toBe(0);
    expect(record.output).toContain("Nothing was run.");
    expect(record.ran).toEqual([]);
  });
});
