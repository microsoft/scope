// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Builders that translate the Portal's current state into the equivalent
 * `scope` CLI command. These power the "Copy as CLI" affordance so a user who
 * configures something visually can switch to the CLI (or wire it into CI)
 * without hunting for the right flags.
 *
 * Design goals:
 * - Accuracy over completeness: only emit flags the CLI actually supports.
 * - Honesty: when the Portal can do something the CLI can't express, surface a
 *   `note` instead of silently dropping it (see issue #1004 parity tracking).
 * - No secrets: token/account values are never embedded.
 */

export interface CliCommand {
  /** Single-line command, suitable for copying / pasting into CI. */
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
function variadicFlag(name: string, values: readonly string[] | undefined): string[] {
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
// Runs
// ---------------------------------------------------------------------------

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
  baseProfileId?: string | null;
  /** Portal-only knobs that the CLI submit command cannot express directly. */
  occurrences?: number;
  priority?: number;
  /**
   * True when a base profile + at least one variation is selected. In this mode
   * the Portal (and API) ignore per-run worker/model/tool fields in favour of
   * the profiles, so we suppress them here too and point at the variations file.
   */
  variationMode?: boolean;
}

const DEFAULT_WORKER = "coder-acp-copilot";

export function buildRunSubmit(state: RunSubmitState): CliCommand {
  const variationMode = state.variationMode ?? false;
  const tokens = [BINARY, "run", "submit"];
  tokens.push(...flag("-m", state.task));
  tokens.push(...variadicFlag("-c", state.criteria));
  // In variation mode the Portal omits per-run worker/model/tool fields; the
  // profiles supply them, so the CLI command must omit them as well.
  if (!variationMode) {
    // The CLI defaults worker to coder-acp-copilot; only emit when it differs.
    if (state.worker && state.worker !== DEFAULT_WORKER) {
      tokens.push(...flag("-w", state.worker));
    }
    tokens.push(...flag("--model", state.model));
    tokens.push(...flag("--reasoning-effort", state.reasoningEffort));
  }
  // The CLI defaults max-iterations to 10; only emit when it differs.
  if (state.maxIterations !== undefined && state.maxIterations !== 10) {
    tokens.push(...flag("--max-iterations", state.maxIterations));
  }
  if (!variationMode) {
    tokens.push(...variadicFlag("--mcp-servers", state.mcpServers));
    tokens.push(...variadicFlag("--skills", state.skills));
    tokens.push(...variadicFlag("--extensions", state.extensions));
    tokens.push(...flag("--agent-version", state.agentVersion));
  }
  tokens.push(...flag("--profile", state.baseProfileId ?? undefined));

  const notes: string[] = [];
  if (state.occurrences !== undefined && state.occurrences > 1) {
    notes.push(
      `Occurrences (${state.occurrences}) submit one run per CLI invocation — run the command ${state.occurrences}× or use a loop.`,
    );
  }
  if (state.priority !== undefined && state.priority !== 0) {
    notes.push(`Priority (${state.priority}) is set in the Portal only; \`run submit\` has no --priority flag.`);
  }
  if (variationMode) {
    notes.push("Profile variations require --profile-variations-file <path> (export the variations to JSON first).");
  }
  return assemble(tokens, notes);
}

export type IterationOp = "eq" | "gte" | "lte";

const OP_SYMBOL: Record<IterationOp, string> = { eq: "=", gte: ">=", lte: "<=" };

export interface RunListState {
  worker?: string | null;
  submissionId?: string | null;
  turns?: string | null;
  turnsOp?: IterationOp | null;
  maxIter?: string | null;
  maxIterOp?: IterationOp | null;
  includeDeleted?: boolean;
  /** Active UI filters the CLI `run list` cannot express, for honest notes. */
  unsupportedFilters?: readonly string[];
}

export function buildRunList(state: RunListState): CliCommand {
  const tokens = [BINARY, "run", "list"];
  tokens.push(...flag("-w", state.worker ?? undefined));
  tokens.push(...flag("--submission-id", state.submissionId ?? undefined));
  if (state.turns) {
    const op = OP_SYMBOL[state.turnsOp ?? "gte"];
    tokens.push(...flag("--turns", `${op}${state.turns}`));
  }
  if (state.maxIter) {
    const op = OP_SYMBOL[state.maxIterOp ?? "gte"];
    tokens.push(...flag("--max-iterations", `${op}${state.maxIter}`));
  }
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
 * `cancel` is variadic in the CLI, so all ids go on one command; `delete`,
 * `retry` and `download` take a single id, so >1 selection becomes a loop.
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
  const force = action === "retry" && opts?.force ? " -f" : "";
  const list = quoted.join(" ");
  const command = `for id in ${list}; do ${BINARY} run ${action} -i "$id"${force}; done`;
  return { command, display: command, notes: [] };
}
