// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  formatRecipeCommand,
  formatStep,
  groupByCategory,
  HIDDEN_SCRIPTS,
  otherScriptRecipes,
  PNPM_BUILTINS,
  RECIPES,
  stepScript,
  type Recipe,
} from "./catalog.js";
import { readRootScripts, ROOT } from "./main.js";

const rootScripts = readRootScripts(ROOT);

describe("RECIPES", () => {
  it("only runs root scripts that exist, or pnpm built-ins", () => {
    const unknown = RECIPES.flatMap((recipe) => recipe.steps.map(stepScript)).filter(
      (script) => !(script in rootScripts) && !PNPM_BUILTINS.has(script),
    );

    expect(unknown).toEqual([]);
  });

  it("uses unique ids", () => {
    const ids = RECIPES.map((recipe) => recipe.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only allows the last step to be long-running", () => {
    // A long-running step never exits on its own, so any later step would never run.
    const misplaced = RECIPES.filter((recipe) => recipe.steps.slice(0, -1).some((recipeStep) => recipeStep.longRunning));
    expect(misplaced.map((recipe) => recipe.id)).toEqual([]);
  });

  it("uses known categories and never the generated 'other' category", () => {
    const known = new Set<string>(CATEGORIES.map((category) => category.id));

    for (const recipe of RECIPES) {
      expect(known.has(recipe.category), recipe.id).toBe(true);
      expect(recipe.category, recipe.id).not.toBe("other");
    }
  });
});

describe("HIDDEN_SCRIPTS", () => {
  it("only lists scripts that still exist, so stale entries get cleaned up", () => {
    const stale = Object.keys(HIDDEN_SCRIPTS).filter((script) => !(script in rootScripts));
    expect(stale).toEqual([]);
  });

  it("includes the guide's own entry points", () => {
    expect(rootScripts.start).toBe("node scripts/guide/launch.mjs");
    expect(rootScripts.scope).toBe("node scripts/guide/launch.mjs");
    expect(HIDDEN_SCRIPTS).toHaveProperty("start");
    expect(HIDDEN_SCRIPTS).toHaveProperty("scope");
  });
});

describe("otherScriptRecipes", () => {
  const curated: Recipe[] = [
    { id: "unit", title: "Unit tests", summary: "", category: "test", steps: [{ pnpm: ["test"] }] },
  ];

  it("wraps unreferenced, non-hidden scripts in sorted fallback recipes", () => {
    const scripts = { test: "vitest run", zeta: "echo z", alpha: "echo a", start: "node scripts/guide/launch.mjs" };

    const recipes = otherScriptRecipes(scripts, curated);

    expect(recipes.map((recipe) => recipe.id)).toEqual(["script:alpha", "script:zeta"]);
    expect(recipes[0]).toMatchObject({ title: "alpha", category: "other", summary: "Runs: echo a", steps: [{ pnpm: ["alpha"] }] });
  });

  it("truncates very long commands in the summary", () => {
    const [recipe] = otherScriptRecipes({ long: "x".repeat(500) }, curated);
    expect(recipe.summary.length).toBeLessThanOrEqual("Runs: ".length + 160);
    expect(recipe.summary.endsWith("…")).toBe(true);
  });
});

describe("formatting", () => {
  it("prints steps as typed, quoting only arguments a shell would split", () => {
    expect(formatStep({ pnpm: ["dev:up", "--mode=kind", "--services=api,portal"] })).toBe("pnpm dev:up --mode=kind --services=api,portal");
    expect(formatStep({ pnpm: ["cli", "submit", "-m", "hello world"] })).toBe('pnpm cli submit -m "hello world"');
  });

  it("joins multi-step recipes with &&", () => {
    const recipe = RECIPES.find((candidate) => candidate.id === "pr-check");
    expect(recipe && formatRecipeCommand(recipe)).toBe("pnpm lint && pnpm test && pnpm headers:check && pnpm notice:check");
  });

  it("groups recipes in category order and skips empty categories", () => {
    const groups = groupByCategory([
      { id: "b", title: "B", summary: "", category: "test", steps: [] },
      { id: "a", title: "A", summary: "", category: "setup", steps: [] },
    ]);

    expect(groups.map((group) => group.id)).toEqual(["setup", "test"]);
  });
});
