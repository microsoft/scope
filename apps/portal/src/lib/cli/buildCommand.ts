// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Builders that translate the Portal's current state into the equivalent
 * `scope` CLI command. These power the "Copy as CLI" affordance so a user who
 * configures something visually can switch to the CLI (or wire it into CI)
 * without hunting for the right flags.
 *
 * Design goals:
 * - Accuracy over completeness: only emit flags the CLI actually supports
 *   (mirrors `apps/cli/src/commands/run.ts`).
 * - Honesty: when the Portal can do something the CLI can't express, surface a
 *   `note` instead of silently dropping it (see issue #1004 parity tracking).
 * - No secrets: token/account values are never embedded. Project and API URL
 *   are supplied via `SCOPE_PROJECT` / `SCOPE_API_URL` by the CliCommand modal.
 */

export interface CliCommand {
  /** Exact command written to the clipboard. */
  command: string;
  /** Multi-line, backslash-continued rendition for readable display. */
  display: string;
  /** Caveats: Portal-only state that the CLI cannot currently express. */
  notes: string[];
}

const BINARY = "scope";

/**
 * Quote a token for POSIX shells. Bare words that only contain safe characters
 * are left untouched; everything else is wrapped in single quotes with embedded
 * single quotes escaped using the `'\''` idiom.
 */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A single-valued flag. Returns [] when the value is empty/nullish. */
function flag(name: string, value: string | number | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const str = String(value);
  if (str === "") return [];
  return [name, shellQuote(str)];
}

/** A variadic flag (`--criteria a b c`). Returns [] for empty lists. */
function variadicFlag(name: string, values: readonly string[] | null | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [name, ...values.map(shellQuote)];
}

/** A boolean flag, emitted only when `on` is true. */
function boolFlag(name: string, on: boolean | undefined): string[] {
  return on ? [name] : [];
}

/** Assemble tokens into a {command, display, notes} triple. */
function assemble(tokens: string[], notes: string[] = []): CliCommand {
  const command = tokens.join(" ");
  // For display, break before every top-level flag (tokens starting with `-`)
  // so long commands wrap readably with trailing backslashes.
  const lines: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith("-") && lines.length > 0) {
      lines.push(tok);
    } else if (lines.length === 0) {
      lines.push(tok);
    } else {
      lines[lines.length - 1] += ` ${tok}`;
    }
  }
  const display = lines.join(" \\\n  ");
  return { command, display, notes };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** The CLI installer one-liner (see docs/architecture/cli-distribution.md). */
export const CLI_INSTALL_COMMAND =
  "curl --fail --location https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh | bash";

/**
 * Environment setup pointing the CLI at an API and (optionally) a project.
 * `run submit` / `run list` require a project. Never includes credentials.
 */
export function buildEnvCommand(apiBaseUrl: string, projectId?: string): string {
  const lines = [`export SCOPE_API_URL=${shellQuote(apiBaseUrl)}`];
  if (projectId) lines.push(`export SCOPE_PROJECT=${shellQuote(projectId)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Mirrors `ResourceBindingSpec` (`--resources` + `--resource-param`). */
export interface CliResourceSpec {
  ref: string;
  params?: Record<string, string>;
}

export interface RunSubmitState {
  task?: string;
  criteria?: readonly string[];
  worker?: string;
  model?: string;
  reasoningEffort?: string;
  maxIterations?: number;
  mcpServers?: readonly string[];
  skills?: readonly string[];
  extensions?: readonly string[];
  agentVersion?: string;
  codebase?: string | null;
  resources?: readonly CliResourceSpec[];
  agentsMd?: string;
  /** `GateConfig[]` as sent to the API; serialised inline for `--gates`. */
  gates?: readonly object[];
  /** Base profile spec (`id` or `id@version`). */
  baseProfileId?: string | null;
  /**
   * Profile variation specs (`id` or `id@version`). With a base profile these
   * switch the submission to variation mode: the Portal (and API) ignore
   * per-run worker/model/tool fields in favour of the profiles, so they are
   * suppressed here too and the variations go through a JSON file.
   */
  profileVariations?: readonly string[];
  /** Runs per profile (`--count`, 1-10). */
  occurrences?: number;
  /** Portal-only: `run submit` has no --priority flag. */
  priority?: number;
}

/** Matches the API's `MULTI_TURN_DEFAULTS.MAX_ITERATIONS`. */
const DEFAULT_MAX_ITERATIONS = 10;
const MAX_COUNT = 10;
export const PROFILE_VARIATIONS_FILE = "profile-variations.json";

export function buildRunSubmit(state: RunSubmitState): CliCommand {
  const variations = state.profileVariations ?? [];
  const variationMode = !!state.baseProfileId && variations.length > 0;
  const notes: string[] = [];
  const tokens = [BINARY, "run", "submit"];

  tokens.push(...flag("-m", state.task?.trim()));
  tokens.push(...variadicFlag("-c", state.criteria));
  // In variation mode the Portal omits per-run worker/model/tool fields; the
  // profiles supply them, so the CLI command must omit them as well.
  if (!variationMode) {
    // The CLI has no default worker: `--worker` is required unless a profile
    // supplies it, so always emit it when the Portal has one selected.
    tokens.push(...flag("-w", state.worker));
    tokens.push(...flag("--model", state.model));
    tokens.push(...flag("--reasoning-effort", state.reasoningEffort));
  }
  if (state.maxIterations !== undefined && state.maxIterations !== DEFAULT_MAX_ITERATIONS) {
    tokens.push(...flag("--max-iterations", state.maxIterations));
  }
  if (state.occurrences !== undefined && state.occurrences > 1) {
    if (state.occurrences <= MAX_COUNT) {
      tokens.push(...flag("--count", state.occurrences));
    } else {
      notes.push(`Occurrences (${state.occurrences}) exceed the CLI's --count limit of ${MAX_COUNT}.`);
    }
  }
  if (!variationMode) {
    tokens.push(...variadicFlag("--mcp-servers", state.mcpServers));
    tokens.push(...variadicFlag("--skills", state.skills));
    tokens.push(...variadicFlag("--extensions", state.extensions));
    tokens.push(...flag("--agent-version", state.agentVersion));
  }
  tokens.push(...flag("--codebase", state.codebase ?? undefined));

  const resources = (state.resources ?? []).filter((r) => r.ref.trim() !== "");
  tokens.push(...variadicFlag("--resources", resources.map((r) => r.ref)));
  for (const resource of resources) {
    for (const [key, value] of Object.entries(resource.params ?? {})) {
      tokens.push(...flag("--resource-param", `${resource.ref}:${key}=${value}`));
    }
  }

  if (state.agentsMd && state.agentsMd.trim()) {
    // The CLI reads `--agents-md @path` from a file, so literal content that
    // starts with `@` cannot be passed inline.
    if (state.agentsMd.startsWith("@")) {
      notes.push("AGENTS.md content starts with `@`, which the CLI reads as a file path — save it to a file and pass `--agents-md @<path>`.");
    } else {
      tokens.push(...flag("--agents-md", state.agentsMd));
    }
  }
  if (state.gates && state.gates.length > 0) {
    tokens.push(...flag("--gates", JSON.stringify(state.gates)));
  }
  tokens.push(...flag("--profile", state.baseProfileId ?? undefined));
  if (variationMode) {
    tokens.push(...flag("--profile-variations-file", PROFILE_VARIATIONS_FILE));
    notes.push(
      `Save the profile variations to ${PROFILE_VARIATIONS_FILE} first: ` +
        `echo ${shellQuote(JSON.stringify(variations))} > ${PROFILE_VARIATIONS_FILE}`,
    );
  }

  if (state.priority !== undefined && state.priority !== 0) {
    notes.push(`Priority (${state.priority}) is set in the Portal only; \`run submit\` has no --priority flag.`);
  }
  return assemble(tokens, notes);
}

export type IterationOp = "eq" | "gte" | "lte";

const OP_SYMBOL: Record<IterationOp, string> = { eq: "=", gte: ">=", lte: "<=" };

export interface RunListState {
  workers?: readonly string[];
  statuses?: readonly string[];
  outcomes?: readonly string[];
  models?: readonly string[];
  os?: readonly string[];
  priorities?: readonly string[];
  agentVersions?: readonly string[];
  profiles?: readonly string[];
  task?: string | null;
  criteria?: string | null;
  search?: string | null;
  /** ISO-8601 datetime (inclusive lower bound). */
  createdAfter?: string | null;
  /** ISO-8601 datetime (inclusive upper bound). */
  createdBefore?: string | null;
  submissionId?: string | null;
  turns?: string | null;
  turnsOp?: IterationOp | null;
  maxIter?: string | null;
  maxIterOp?: IterationOp | null;
  sortBy?: string | null;
  sortDir?: "asc" | "desc" | null;
  includeDeleted?: boolean;
  /** Active UI filters the CLI `run list` cannot express, for honest notes. */
  unsupportedFilters?: readonly string[];
}

export function buildRunList(state: RunListState): CliCommand {
  const tokens = [BINARY, "run", "list"];
  tokens.push(...variadicFlag("-w", state.workers));
  tokens.push(...variadicFlag("--status", state.statuses));
  tokens.push(...variadicFlag("--outcome", state.outcomes));
  tokens.push(...flag("--task", state.task));
  tokens.push(...variadicFlag("--profile", state.profiles));
  tokens.push(...flag("--criteria", state.criteria));
  tokens.push(...variadicFlag("--model", state.models));
  tokens.push(...variadicFlag("--os", state.os));
  tokens.push(...variadicFlag("--priority", state.priorities));
  tokens.push(...variadicFlag("--agent-version", state.agentVersions));
  tokens.push(...flag("--search", state.search?.trim()));
  tokens.push(...flag("--created-after", state.createdAfter));
  tokens.push(...flag("--created-before", state.createdBefore));
  tokens.push(...flag("--submission-id", state.submissionId));
  if (state.turns) {
    const op = OP_SYMBOL[state.turnsOp ?? "gte"];
    tokens.push(...flag("--turns", `${op}${state.turns}`));
  }
  if (state.maxIter) {
    const op = OP_SYMBOL[state.maxIterOp ?? "gte"];
    tokens.push(...flag("--max-iterations", `${op}${state.maxIter}`));
  }
  tokens.push(...flag("--sort-by", state.sortBy));
  if (state.sortBy) tokens.push(...flag("--sort-dir", state.sortDir));
  tokens.push(...boolFlag("--include-deleted", state.includeDeleted));

  const notes: string[] = [];
  if (state.unsupportedFilters && state.unsupportedFilters.length > 0) {
    notes.push(
      `Filtered in the Portal only (no \`run list\` flag): ${state.unsupportedFilters.join(", ")}.`,
    );
  }
  return assemble(tokens, notes);
}

export function buildRunGet(id: string): CliCommand {
  return assemble([BINARY, "run", "get", "-i", shellQuote(id)]);
}

export type RunAction = "retry" | "cancel" | "delete" | "download";

export function buildRunAction(action: RunAction, id: string, opts?: { force?: boolean }): CliCommand {
  const tokens = [BINARY, "run", action, "-i", shellQuote(id)];
  if (action === "retry" && opts?.force) tokens.push("-f");
  return assemble(tokens);
}

/**
 * Build a command for a bulk action over a selection of run IDs.
 * `cancel` is variadic and `download` has a `download-batch` sibling, so both
 * become one command; `delete` and `retry` take a single id, so >1 selection
 * becomes a loop.
 */
export function buildRunBulk(action: RunAction, ids: readonly string[], opts?: { force?: boolean }): CliCommand {
  const quoted = ids.map(shellQuote);
  if (ids.length === 0) {
    return assemble([BINARY, "run", action, "-i", "RUN_ID"]);
  }
  if (action === "cancel") {
    return assemble([BINARY, "run", "cancel", "-i", ...quoted]);
  }
  if (ids.length === 1) {
    return buildRunAction(action, ids[0], opts);
  }
  if (action === "download") {
    return assemble([BINARY, "run", "download-batch", "-i", ...quoted]);
  }
  const force = action === "retry" && opts?.force ? " -f" : "";
  const list = quoted.join(" ");
  const command = `for id in ${list}; do ${BINARY} run ${action} -i "$id"${force}; done`;
  return { command, display: command, notes: [] };
}
