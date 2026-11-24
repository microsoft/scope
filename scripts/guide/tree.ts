// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// tree.ts — Questions the contributor guide asks to pick a recipe
// =============================================================================
// Each node asks one question; each choice either opens another node or
// resolves to a recipe from catalog.ts. "Browse all commands" nodes are
// generated from the catalog so every recipe stays reachable.
// =============================================================================

import { formatRecipeCommand, groupByCategory, type Recipe } from "./catalog.js";

/** A choice that opens another question. */
export interface NodeChoice {
  /** Menu label. */
  label: string;
  /** Short explanation shown next to the label. */
  hint?: string;
  /** Id of the node to open. */
  node: string;
  /** Selected when the user just presses Enter. At most one per node. */
  recommended?: boolean;
}

/** A choice that resolves to a recipe. */
export interface RecipeChoice {
  /** Menu label (default: the recipe title). */
  label?: string;
  /** Short explanation (default: the recipe summary). */
  hint?: string;
  /** Id of the recipe to run. */
  recipe: string;
  /** Selected when the user just presses Enter. At most one per node. */
  recommended?: boolean;
}

export type Choice = NodeChoice | RecipeChoice;

/** One question in the guide. */
export interface DecisionNode {
  id: string;
  question: string;
  choices: Choice[];
}

export const ROOT_NODE = "root";
export const BROWSE_NODE = "browse";

/** The hand-written part of the decision tree, starting at {@link ROOT_NODE}. */
export const TREE: DecisionNode[] = [
  {
    id: ROOT_NODE,
    question: "What would you like to do?",
    choices: [
      { label: "Get set up (first time)", hint: "Check your tools and install dependencies", recipe: "setup" },
      { label: "Run Scope locally", hint: "Full stack, a single service, or the devcontainer", node: "run" },
      { label: "Work on the Portal", hint: "Open the Portal, Storybook, or Portal + API only", node: "portal" },
      { label: "Run tests", hint: "Unit, integration or gateway tests", node: "test" },
      { label: "Check my changes before opening a PR", hint: "Lint, tests, license headers and notices", node: "pr" },
      { label: "Database migrations", hint: "Status, apply or roll back", node: "database" },
      { label: "Stop or clean up", hint: "Stop stacks, delete local data, prune worktrees", node: "cleanup" },
      { label: "Use the Scope CLI", hint: "Submit runs, stream logs, manage criteria", recipe: "cli-help" },
      { label: "Browse all commands", hint: "Every pnpm script, grouped by topic", node: BROWSE_NODE },
    ],
  },
  {
    id: "run",
    question: "How do you want to run Scope?",
    choices: [
      { label: "Docker Compose with hot reload", hint: "Recommended; the only option that runs coding-agent workers", node: "run-compose", recommended: true },
      { label: "One service as a local process", hint: "Fastest reloads and simplest debugging for a single service", node: "run-native" },
      { label: "Devcontainer (experimental)", hint: "Native or Kubernetes (Kind) mode inside the devcontainer", node: "run-devcontainer" },
      { recipe: "infra-only" },
    ],
  },
  {
    id: "run-compose",
    question: "Which coding-agent worker do you need?",
    choices: [
      { label: "GitHub Copilot", recipe: "compose-copilot", recommended: true },
      { label: "Claude Code", recipe: "compose-claude-code" },
      { label: "Both", recipe: "compose-all" },
      { label: "None, just the Portal and API", recipe: "compose-portal" },
    ],
  },
  {
    id: "run-native",
    question: "Which service do you want to run locally?",
    choices: [
      { label: "API", recipe: "native-api", recommended: true },
      { label: "Portal", recipe: "native-portal" },
      { label: "Copilot worker", recipe: "native-coder-acp-copilot" },
      { label: "Claude Code worker", recipe: "native-coder-acp-claude-code" },
      { label: "Report generator", recipe: "native-report-generator" },
      { label: "Token manager", recipe: "native-token-manager" },
    ],
  },
  {
    id: "run-devcontainer",
    question: "Which devcontainer mode?",
    choices: [
      { label: "Native mode", recipe: "devcontainer-native", recommended: true },
      { label: "Kind mode, first start (builds images)", recipe: "devcontainer-kind-build" },
      { label: "Kind mode, later starts", recipe: "devcontainer-kind" },
      { recipe: "dev-doctor" },
      { recipe: "dev-logs" },
      { recipe: "dev-down" },
    ],
  },
  {
    id: "portal",
    question: "What do you want to do with the Portal?",
    choices: [
      { recipe: "open-portal", recommended: true },
      { recipe: "portal-url" },
      { recipe: "storybook" },
      { label: "Run the Portal and API with hot reload (Docker)", recipe: "compose-portal" },
      { label: "Run only the Portal as a local process", recipe: "native-portal" },
    ],
  },
  {
    id: "test",
    question: "Which tests do you want to run?",
    choices: [
      { recipe: "test-unit", recommended: true },
      { recipe: "test-watch" },
      { recipe: "test-coverage" },
      { recipe: "test-integration" },
      { recipe: "test-integration-queue" },
      { recipe: "test-gateway" },
    ],
  },
  {
    id: "pr",
    question: "Did you change the Rust gateway (apps/gateway)?",
    choices: [
      { label: "No, TypeScript checks only", recipe: "pr-check", recommended: true },
      { label: "Yes, also run the Rust checks", recipe: "pr-check-gateway" },
    ],
  },
  {
    id: "database",
    question: "What do you need?",
    choices: [
      { recipe: "migrate-status", recommended: true },
      { recipe: "migrate-up" },
      { recipe: "migrate-down" },
      { label: "Use the shared CosmosDB dev instance", node: "browse:infra" },
    ],
  },
  {
    id: "cleanup",
    question: "What do you want to stop or clean up?",
    choices: [
      { recipe: "docker-down" },
      { recipe: "dev-down" },
      { recipe: "worktrees-clean" },
    ],
  },
];

/**
 * Generate the "Browse all commands" nodes: one node listing categories, and
 * one node per category listing its recipes with their exact commands.
 *
 * @param recipes - Every recipe the guide knows, including fallback "Other scripts".
 */
export function buildBrowseNodes(recipes: readonly Recipe[]): DecisionNode[] {
  const groups = groupByCategory(recipes);

  const categoryNode: DecisionNode = {
    id: BROWSE_NODE,
    question: "Which topic?",
    choices: groups.map((group) => ({
      label: group.title,
      hint: `${group.recipes.length} command${group.recipes.length === 1 ? "" : "s"}`,
      node: `browse:${group.id}`,
    })),
  };

  const recipeNodes = groups.map((group) => ({
    id: `browse:${group.id}`,
    question: `${group.title}: which command?`,
    choices: group.recipes.map((recipe) => ({ recipe: recipe.id })),
  }));

  return [categoryNode, ...recipeNodes];
}

/** Combine the hand-written tree with the generated browse nodes, keyed by node id. */
export function buildTree(recipes: readonly Recipe[]): Map<string, DecisionNode> {
  const nodes = [...TREE, ...buildBrowseNodes(recipes)];
  return new Map(nodes.map((node) => [node.id, node]));
}

/**
 * Resolve the label and hint a choice displays. Recipe choices fall back to the
 * recipe title and its exact command, so menus teach the command to run directly.
 */
export function describeChoice(choice: Choice, recipes: readonly Recipe[]): { label: string; hint?: string } {
  if ("node" in choice) return { label: choice.label, hint: choice.hint };

  const recipe = recipes.find((candidate) => candidate.id === choice.recipe);
  return {
    label: choice.label ?? recipe?.title ?? choice.recipe,
    hint: choice.hint ?? (recipe ? formatRecipeCommand(recipe) : undefined),
  };
}
