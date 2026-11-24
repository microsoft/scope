// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { allRecipes, readRootScripts, ROOT } from "./main.js";
import { BROWSE_NODE, buildTree, describeChoice, ROOT_NODE, TREE } from "./tree.js";

const recipes = allRecipes(readRootScripts(ROOT));
const tree = buildTree(recipes);

/** Collect every node id reachable from the root by following node choices. */
function reachableNodes(): Set<string> {
  const seen = new Set<string>();
  const queue = [ROOT_NODE];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const choice of tree.get(id)?.choices ?? []) {
      if ("node" in choice) queue.push(choice.node);
    }
  }
  return seen;
}

describe("decision tree", () => {
  it("only points at nodes and recipes that exist", () => {
    const recipeIds = new Set(recipes.map((recipe) => recipe.id));
    const broken: string[] = [];

    for (const node of tree.values()) {
      for (const choice of node.choices) {
        const ok = "node" in choice ? tree.has(choice.node) : recipeIds.has(choice.recipe);
        if (!ok) broken.push(`${node.id} → ${"node" in choice ? choice.node : choice.recipe}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("has no unreachable or empty questions", () => {
    const reachable = reachableNodes();

    for (const node of tree.values()) {
      expect(reachable.has(node.id), node.id).toBe(true);
      expect(node.choices.length, node.id).toBeGreaterThan(0);
    }
  });

  it("recommends at most one choice per question", () => {
    for (const node of TREE) {
      expect(node.choices.filter((choice) => choice.recommended).length, node.id).toBeLessThanOrEqual(1);
    }
  });

  it("keeps every recipe, including fallback scripts, reachable through Browse all commands", () => {
    const browsable = new Set(
      [...tree.values()]
        .filter((node) => node.id.startsWith(`${BROWSE_NODE}:`))
        .flatMap((node) => node.choices.flatMap((choice) => ("recipe" in choice ? [choice.recipe] : []))),
    );

    expect(recipes.filter((recipe) => !browsable.has(recipe.id)).map((recipe) => recipe.id)).toEqual([]);
  });
});

describe("describeChoice", () => {
  it("falls back to the recipe title and exact command", () => {
    expect(describeChoice({ recipe: "test-unit" }, recipes)).toEqual({ label: "Unit tests", hint: "pnpm test" });
  });

  it("keeps explicit labels and hints", () => {
    expect(describeChoice({ label: "Copilot", hint: "custom", recipe: "compose-copilot" }, recipes)).toEqual({ label: "Copilot", hint: "custom" });
    expect(describeChoice({ label: "Run", node: "run" }, recipes)).toEqual({ label: "Run", hint: undefined });
  });
});
