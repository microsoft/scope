// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// catalog.ts — Recipes the contributor guide can explain and run
// =============================================================================
// A recipe is a contributor task ("Run the full stack with Copilot") that maps
// to one or more existing root package.json scripts. The guide only ever runs
// `pnpm <script> [args]` for scripts referenced here (plus `pnpm install`).
//
// When you add a contributor-facing root script, register it in RECIPES (and in
// tree.ts if it deserves a place in the guided menu). Unregistered scripts still
// appear under "Other scripts" with their raw command as the description.
// =============================================================================

import type { RequirementId } from "./requirements.js";

/** Recipe groups, in the order they appear in `--list` and "Browse all commands". */
export const CATEGORIES = [
  { id: "setup", title: "Setup" },
  { id: "run", title: "Run Scope locally" },
  { id: "portal", title: "Portal and Storybook" },
  { id: "test", title: "Tests" },
  { id: "quality", title: "Build, lint and PR checks" },
  { id: "evals", title: "Prompt evaluations" },
  { id: "database", title: "Database" },
  { id: "cleanup", title: "Stop and clean up" },
  { id: "cli", title: "Scope CLI" },
  { id: "infra", title: "Shared dev infrastructure (CosmosDB)" },
  { id: "maintenance", title: "Maintenance tools" },
  { id: "other", title: "Other scripts" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

/**
 * Why a recipe deserves extra care before running:
 * - `destructive`: deletes data or files; confirmation defaults to "No".
 * - `spends-credits`: starts coding agents or LLM calls that consume provider quota.
 * - `experimental`: not yet validated end to end.
 */
export type Caution = "destructive" | "spends-credits" | "experimental";

/** One `pnpm` invocation inside a recipe. */
export interface RecipeStep {
  /**
   * Arguments passed to `pnpm`. The first item is a root package.json script
   * name or a built-in pnpm command listed in {@link PNPM_BUILTINS}; the rest
   * are forwarded to the script (e.g. `["dev:up", "--mode=native"]`).
   */
  pnpm: string[];
  /** The step keeps running until stopped with Ctrl+C (dev servers, watchers). Only the last step may be long-running. */
  longRunning?: boolean;
}

/** A contributor task the guide can explain, check prerequisites for, and run. */
export interface Recipe {
  /** Stable identifier; persisted in the "Run again" history. */
  id: string;
  /** Short title shown in menus. */
  title: string;
  /** One or two sentences explaining what the recipe does and when to use it. */
  summary: string;
  /** Group used by `--list` and "Browse all commands". */
  category: CategoryId;
  /** Commands run in order; the guide stops at the first failing step. */
  steps: RecipeStep[];
  /** Prerequisites that must pass; failures ask before continuing (default: none). */
  requires?: RequirementId[];
  /** Prerequisites shown for information only; never block (default: none). */
  recommends?: RequirementId[];
  /** Highlights risk in the plan and adjusts the confirmation default. */
  caution?: Caution;
  /** Related commands to try next, shown before running (long-running steps occupy the terminal). */
  followUps?: string[];
}

/** Built-in pnpm commands that recipes may use in addition to root scripts. */
export const PNPM_BUILTINS = new Set(["install"]);

/** Root scripts deliberately left out of the guide, with the reason. */
export const HIDDEN_SCRIPTS: Record<string, string> = {
  start: "Launches this guide.",
  scope: "Launches this guide.",
  "get-copilot-token": "Points at a script that no longer exists.",
  "check:versions:vscode-web": "Its workspace package was removed.",
  "check:versions:vscode-electron": "Its workspace package was removed.",
};

/** Build a step that runs to completion. */
function step(...pnpm: string[]): RecipeStep {
  return { pnpm };
}

/** Build a step that keeps running until the user stops it. */
function serve(...pnpm: string[]): RecipeStep {
  return { pnpm, longRunning: true };
}

const OPEN_PORTAL = "pnpm open:portal — open the Portal once the stack is ready (in another terminal)";
const STOP_COMPOSE = "Ctrl+C stops the stack; pnpm docker:down also removes its containers and local data";
const KIND_LOGS = "pnpm dev:logs --service=api — recent logs of a Kind workload (also portal, mongodb, db-migrate…)";

/**
 * Native single-service recipes share one shape: start the backing services in
 * Docker, then run the service as a local process with hot reload. Node services
 * import workspace packages from their build output, so those must be built.
 *
 * @param service - Suffix of the root `dev:<service>` script.
 * @param name - Service name used in the title and summary, e.g. "API".
 * @param extra - Overrides such as extra requirements or follow-ups.
 */
function nativeService(service: string, name: string, extra: Partial<Recipe> = {}): Recipe {
  return {
    id: `native-${service}`,
    title: `${name.charAt(0).toUpperCase()}${name.slice(1)} as a local process`,
    summary: `Starts MongoDB, Redis and Azurite in Docker, then runs the ${name} as a local process with hot reload.`,
    category: "run",
    steps: [step("docker:up:infra"), serve(`dev:${service}`)],
    requires: ["docker", "packages-built"],
    ...extra,
  };
}

/** Every curated recipe, ordered by category. */
export const RECIPES: Recipe[] = [
  // Setup
  {
    id: "setup",
    title: "Install dependencies and check your tools",
    summary: "Checks the tools needed to run Scope locally, then installs workspace dependencies exactly as CI does.",
    category: "setup",
    steps: [step("install", "--frozen-lockfile")],
    recommends: ["node", "docker", "mkcert", "github-token"],
    followUps: ["pnpm start — come back to this guide to run Scope locally"],
  },

  // Run Scope locally: Docker Compose
  {
    id: "compose-copilot",
    title: "Full stack with the GitHub Copilot worker",
    summary: "Builds and starts the Portal, API, Judge, gateway, post-processing, reports and the Copilot worker in Docker with hot reload. The recommended day-to-day setup.",
    category: "run",
    steps: [serve("docker:dev:copilot")],
    requires: ["docker", "mkcert", "github-token"],
    caution: "spends-credits",
    followUps: [OPEN_PORTAL, STOP_COMPOSE],
  },
  {
    id: "compose-claude-code",
    title: "Full stack with the Claude Code worker",
    summary: "Same as the Copilot stack, but with the Claude Code worker instead.",
    category: "run",
    steps: [serve("docker:dev:claude-code")],
    requires: ["docker", "mkcert", "anthropic-key"],
    caution: "spends-credits",
    followUps: [OPEN_PORTAL, STOP_COMPOSE],
  },
  {
    id: "compose-all",
    title: "Full stack with every worker",
    summary: "Starts the full stack with both the Copilot and Claude Code workers, plus reports and post-processing.",
    category: "run",
    steps: [serve("docker:dev:all")],
    requires: ["docker", "mkcert", "github-token", "anthropic-key"],
    caution: "spends-credits",
    followUps: [OPEN_PORTAL, STOP_COMPOSE],
  },
  {
    id: "compose-portal",
    title: "Portal and API only (no workers)",
    summary: "Starts the Portal, API and local sign-in in Docker with hot reload and the API debugger enabled. No coding agents run, so no provider credits are spent.",
    category: "run",
    steps: [serve("docker:dev:portal")],
    requires: ["docker", "mkcert"],
    followUps: [OPEN_PORTAL, "Attach API (Docker) in VS Code Run and Debug, using API_DEBUG_PORT from .env", STOP_COMPOSE],
  },
  {
    id: "infra-only",
    title: "Backing services only (MongoDB, Redis, Azurite)",
    summary: "Starts only the databases and storage emulator in Docker, for running apps natively or for integration tests.",
    category: "run",
    steps: [step("docker:up:infra")],
    requires: ["docker"],
    followUps: ["pnpm dev:api, pnpm dev:portal or pnpm dev:<worker> — run services natively"],
  },

  // Run Scope locally: native processes
  nativeService("api", "API", { followUps: ["pnpm dev:portal — run the Portal in another terminal"] }),
  nativeService("portal", "Portal", { requires: ["docker"], followUps: ["pnpm dev:api — run the API in another terminal"] }),
  nativeService("coder-acp-copilot", "Copilot worker", { requires: ["docker", "packages-built", "github-token"], caution: "spends-credits" }),
  nativeService("coder-acp-claude-code", "Claude Code worker", { requires: ["docker", "packages-built", "anthropic-key"], caution: "spends-credits" }),
  nativeService("report-generator", "report generator"),
  nativeService("token-manager", "token manager"),

  // Run Scope locally: devcontainer
  {
    id: "devcontainer-native",
    title: "Devcontainer, native mode",
    summary: "Runs the databases in the devcontainer's Docker and the API and Portal as processes behind one HTTPS address. Returns once the services are ready.",
    category: "run",
    steps: [step("dev:up", "--mode=native")],
    requires: ["docker", "mkcert"],
    recommends: ["devcontainer"],
    caution: "experimental",
    followUps: ["pnpm dev:logs --service=api — show recent API logs", "pnpm dev:down — stop the environment"],
  },
  {
    id: "devcontainer-kind-build",
    title: "Devcontainer, Kind mode (first start: build images)",
    summary: "Builds the images and runs the API and Portal in a Kind cluster with one ServiceAccount per workload. The first build is large (about 6.5 GB).",
    category: "run",
    steps: [step("dev:up", "--mode=kind", "--services=api,portal", "--build")],
    requires: ["docker", "mkcert"],
    recommends: ["devcontainer"],
    caution: "experimental",
    followUps: [KIND_LOGS, "pnpm dev:down — delete this workspace's cluster"],
  },
  {
    id: "devcontainer-kind",
    title: "Devcontainer, Kind mode (reuse built images)",
    summary: "Starts the API and Portal in a Kind cluster using previously built images.",
    category: "run",
    steps: [step("dev:up", "--mode=kind", "--services=api,portal")],
    requires: ["docker", "mkcert"],
    recommends: ["devcontainer"],
    caution: "experimental",
    followUps: [KIND_LOGS, "pnpm dev:down — delete this workspace's cluster"],
  },
  {
    id: "dev-doctor",
    title: "Check the devcontainer environment",
    summary: "Reports the devcontainer runtime status and which credential variables are present (never their values).",
    category: "run",
    steps: [step("dev:doctor")],
    recommends: ["devcontainer"],
  },
  {
    id: "dev-logs",
    title: "Show devcontainer API logs",
    summary: "Prints the last 100 log lines of the API started with pnpm dev:up, in native or Kind mode. Use --service=<name> for another service, such as portal, mongodb or db-migrate.",
    category: "run",
    steps: [step("dev:logs", "--service=api")],
  },

  // Portal and Storybook
  {
    id: "open-portal",
    title: "Open the running Portal in your browser",
    summary: "Opens the Portal URL for this worktree (ports can differ between worktrees).",
    category: "portal",
    steps: [step("open:portal")],
  },
  {
    id: "portal-url",
    title: "Print the Portal URL",
    summary: "Prints the Portal URL for this worktree without opening a browser.",
    category: "portal",
    steps: [step("portal:url")],
  },
  {
    id: "storybook",
    title: "Start Storybook (Portal component catalog)",
    summary: "Runs Storybook for the Portal components. Update stories when you add or change a component.",
    category: "portal",
    steps: [serve("storybook")],
  },

  // Tests
  {
    id: "test-unit",
    title: "Unit tests",
    summary: "Runs every co-located Vitest unit test once.",
    category: "test",
    steps: [step("test")],
  },
  {
    id: "test-watch",
    title: "Unit tests in watch mode",
    summary: "Re-runs affected Vitest tests as you edit files.",
    category: "test",
    steps: [serve("test:watch")],
  },
  {
    id: "test-coverage",
    title: "Unit tests with coverage",
    summary: "Runs the unit tests and writes a coverage report.",
    category: "test",
    steps: [step("test:coverage")],
  },
  {
    id: "test-integration",
    title: "Integration tests",
    summary: "Runs the integration suites against real backing services. Needs Docker and the generated .env file.",
    category: "test",
    steps: [step("test:integration")],
    requires: ["docker", "env-file"],
  },
  {
    id: "test-integration-queue",
    title: "Queue recovery integration tests",
    summary: "Runs the queue redelivery and stuck-run reaper tests against disposable containers.",
    category: "test",
    steps: [step("test:integration:queue")],
    requires: ["docker"],
  },
  {
    id: "test-gateway",
    title: "Rust gateway tests",
    summary: "Runs cargo test for the AI gateway (apps/gateway).",
    category: "test",
    steps: [step("test:gateway")],
    requires: ["cargo"],
  },

  // Build, lint and PR checks
  {
    id: "pr-check",
    title: "Pre-PR checks (TypeScript)",
    summary: "Runs what CI checks for most changes: lint and typecheck, unit tests, license headers and third-party notices.",
    category: "quality",
    steps: [step("lint"), step("test"), step("headers:check"), step("notice:check")],
    followUps: ["pnpm headers — add missing license headers", "pnpm notice — regenerate notices after dependency changes"],
  },
  {
    id: "pr-check-gateway",
    title: "Pre-PR checks (TypeScript + Rust gateway)",
    summary: "Runs the TypeScript checks, then cargo fmt, clippy and tests for the AI gateway.",
    category: "quality",
    steps: [
      step("lint"),
      step("test"),
      step("headers:check"),
      step("notice:check"),
      step("fmt:gateway"),
      step("lint:gateway"),
      step("test:gateway"),
    ],
    requires: ["cargo"],
    followUps: ["pnpm headers — add missing license headers", "pnpm notice — regenerate notices after dependency changes"],
  },
  {
    id: "build",
    title: "Build every workspace package",
    summary: "Runs the build script of every workspace package.",
    category: "quality",
    steps: [step("build")],
  },
  {
    id: "lint",
    title: "Lint and typecheck every package",
    summary: "Runs the lint script of every workspace package.",
    category: "quality",
    steps: [step("lint")],
  },
  {
    id: "headers",
    title: "Add missing license headers",
    summary: "Adds the Microsoft MIT header to first-party source files that lack it.",
    category: "quality",
    steps: [step("headers")],
  },
  {
    id: "notice",
    title: "Regenerate third-party notices",
    summary: "Regenerates NOTICE and NOTICE-REVIEW.txt after dependency changes. Never edit those files by hand.",
    category: "quality",
    steps: [step("notice")],
  },
  {
    id: "build-cli",
    title: "Build the Scope CLI bundle",
    summary: "Builds the shared package and the standalone CLI bundle.",
    category: "quality",
    steps: [step("build:cli")],
  },
  {
    id: "build-gateway",
    title: "Build the Rust gateway",
    summary: "Runs cargo build --release for the AI gateway.",
    category: "quality",
    steps: [step("build:gateway")],
    requires: ["cargo"],
  },

  // Prompt evaluations
  {
    id: "eval-static-prompts-smoke",
    title: "Static prompt evaluations (offline smoke test)",
    summary: "Checks the static prompt evaluation harness offline, without calling any model.",
    category: "evals",
    steps: [step("eval:static-prompts:smoke")],
  },
  {
    id: "eval-prompts",
    title: "Static prompt evaluations",
    summary: "Evaluates Scope's own AI prompts. Read docs/architecture/prompt-evaluations.md first.",
    category: "evals",
    steps: [step("eval:prompts")],
    caution: "spends-credits",
  },
  {
    id: "eval-criteria-prompts",
    title: "Criteria prompt evaluations",
    summary: "Runs the LLM-graded criteria prompt evaluations. Needs model credentials in .env.",
    category: "evals",
    steps: [step("eval:criteria-prompts")],
    requires: ["env-file"],
    caution: "spends-credits",
  },

  // Database
  {
    id: "migrate-status",
    title: "Show migration status",
    summary: "Lists applied and pending database migrations. Uses MONGODB_URI and MONGO_DATABASE from your shell, or local MongoDB by default.",
    category: "database",
    steps: [step("migrate:status")],
    requires: ["docker"],
  },
  {
    id: "migrate-up",
    title: "Apply pending migrations",
    summary: "Applies pending database migrations. The Docker stacks already do this on startup.",
    category: "database",
    steps: [step("migrate:up")],
    requires: ["docker"],
  },
  {
    id: "migrate-down",
    title: "Roll back the last migration",
    summary: "Runs the down() step of the most recently applied migration.",
    category: "database",
    steps: [step("migrate:down")],
    requires: ["docker"],
    caution: "destructive",
  },

  // Stop and clean up
  {
    id: "docker-down",
    title: "Stop the Docker Compose stack and delete its data",
    summary: "Stops this worktree's Compose services and removes their containers and volumes, wiping the local databases.",
    category: "cleanup",
    steps: [step("docker:down")],
    requires: ["docker"],
    caution: "destructive",
  },
  {
    id: "dev-down",
    title: "Stop the devcontainer environment",
    summary: "Stops the processes, containers or Kind cluster started with pnpm dev:up. Data volumes are kept.",
    category: "cleanup",
    steps: [step("dev:down")],
    requires: ["docker"],
  },
  {
    id: "worktrees-clean",
    title: "Clean up merged or closed worktrees",
    summary: "Removes Docker resources of deleted worktrees, then offers to remove worktrees whose pull requests are merged or closed.",
    category: "cleanup",
    steps: [step("worktrees:clean")],
    caution: "destructive",
  },

  // Scope CLI
  {
    id: "cli-help",
    title: "Discover Scope CLI commands",
    summary: "Shows the Scope CLI subcommands, run from source. Use pnpm cli <command> to submit runs, stream logs and manage criteria.",
    category: "cli",
    steps: [step("cli", "--help")],
    requires: ["packages-built"],
  },

  // Shared dev infrastructure
  {
    id: "shared-infra-setup",
    title: "Deploy the shared CosmosDB dev account",
    summary: "One-time, per-user setup with the Azure Developer CLI (azd). See docs/shared-dev-infra.md.",
    category: "infra",
    steps: [step("shared-infra:setup")],
  },
  {
    id: "shared-infra-use",
    title: "Use the shared CosmosDB for this worktree",
    summary: "Points this worktree at its own database on the shared CosmosDB account instead of local MongoDB.",
    category: "infra",
    steps: [step("shared-infra:use")],
  },
  {
    id: "shared-infra-use-off",
    title: "Go back to local MongoDB",
    summary: "Stops using the shared CosmosDB for this worktree.",
    category: "infra",
    steps: [step("shared-infra:use:off")],
  },
  {
    id: "shared-infra-clean",
    title: "Reset this worktree's shared CosmosDB database",
    summary: "Drops this worktree's database on the shared account (asks for confirmation); it is recreated on the next app start.",
    category: "infra",
    steps: [step("shared-infra:clean")],
    caution: "destructive",
  },

  // Maintenance tools
  {
    id: "check-versions-acp-copilot",
    title: "Check for new Copilot ACP releases",
    summary: "Polls for new GitHub Copilot ACP versions.",
    category: "maintenance",
    steps: [step("check:versions:acp-copilot")],
  },
  {
    id: "check-versions-claude-code",
    title: "Check for new Claude Code releases",
    summary: "Polls for new Claude Code versions.",
    category: "maintenance",
    steps: [step("check:versions:claude-code")],
  },
];

/** Find a recipe by its stable id. */
export function findRecipe(recipes: readonly Recipe[], id: string): Recipe | undefined {
  return recipes.find((recipe) => recipe.id === id);
}

/** Quote an argument for display only when a shell would split or expand it. */
function displayArgument(argument: string): string {
  return /^[\w@%+=:,./<>-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

/** Format one step exactly as a contributor would type it, e.g. `pnpm dev:up --mode=native`. */
export function formatStep(recipeStep: RecipeStep): string {
  return ["pnpm", ...recipeStep.pnpm.map(displayArgument)].join(" ");
}

/** Format a whole recipe as a single copy-pasteable command line. */
export function formatRecipeCommand(recipe: Recipe): string {
  return recipe.steps.map(formatStep).join(" && ");
}

/** The root script (or pnpm built-in) a step invokes. */
export function stepScript(recipeStep: RecipeStep): string {
  return recipeStep.pnpm[0];
}

/** Shorten a raw script command so it fits in a menu hint. */
function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Build fallback recipes for root scripts that no curated recipe references,
 * so "Browse all commands" and `--list` always cover the whole package.json.
 *
 * @param scripts - The root package.json `scripts` map (name → command).
 * @param curated - Recipes whose referenced scripts are excluded.
 */
export function otherScriptRecipes(scripts: Record<string, string>, curated: readonly Recipe[]): Recipe[] {
  const referenced = new Set(curated.flatMap((recipe) => recipe.steps.map(stepScript)));

  return Object.keys(scripts)
    .filter((name) => !referenced.has(name) && !(name in HIDDEN_SCRIPTS))
    .sort()
    .map((name) => ({
      id: `script:${name}`,
      title: name,
      summary: `Runs: ${truncate(scripts[name], 160)}`,
      category: "other" as const,
      steps: [step(name)],
    }));
}

/** Group recipes by category, following {@link CATEGORIES} order and skipping empty groups. */
export function groupByCategory(recipes: readonly Recipe[]): Array<{ id: CategoryId; title: string; recipes: Recipe[] }> {
  return CATEGORIES.map((category) => ({
    id: category.id,
    title: category.title,
    recipes: recipes.filter((recipe) => recipe.category === category.id),
  })).filter((group) => group.recipes.length > 0);
}
