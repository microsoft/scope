// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Persisted CLI configuration stored at `~/.config/scope/config.json`.
 *
 * Today this holds only the **selected project** — the project whose data
 * scoped commands (`run list`, entity lists, root creates) operate on. The
 * Scope API requires an explicit `?projectId=` on every scoped call and never
 * falls back to a default, so the CLI must resolve a concrete project id before
 * issuing those requests.
 *
 * Named actions instead use their pinned environment's SCOPE_PROJECT and
 * persist changes to that environment's .env; they never read the legacy
 * config or ambient SCOPE_PROJECT. Explicit --project overrides either mode.
 *
 * Resolution precedence (highest first), see {@link resolveProjectId}:
 *  1. an explicit `--project <id>` flag,
 *  2. the `SCOPE_PROJECT` environment variable,
 *  3. the persisted `selectedProjectId` (set via `scope project use <id>`).
 *
 * When none of those yield a value the project is **undefined** — there is no
 * implicit default. Commands that require scoping call {@link requireProjectId}
 * to turn that into a clear, actionable error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCliName } from "./shared.js";
import { currentEnvironment } from "./connection.js";
import { EnvironmentStore } from "./environments.js";

/** Directory holding all CLI state (shared with the update checker). */
const CONFIG_DIR = join(homedir(), ".config", "scope");
/** Path to the persisted CLI config document. */
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/** Shape of `~/.config/scope/config.json`. Intentionally open for forward-compat. */
export interface ScopeConfig {
  /** Id of the project scoped commands operate on, when one has been selected. */
  selectedProjectId?: string;
}

/** Read the persisted config, tolerating a missing or malformed file. */
export function readConfig(): ScopeConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ScopeConfig;
    }
    return {};
  } catch {
    // A corrupt config must never break a command — treat it as empty.
    return {};
  }
}

/** Persist the config, creating `~/.config/scope/` on first write. */
export function writeConfig(config: ScopeConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

/** The persisted selected project id, or `undefined` if none has been chosen. */
export function getSelectedProjectId(): string | undefined {
  const environment = currentEnvironment();
  if (environment) return environment.project;
  const id = readConfig().selectedProjectId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/**
 * Persist (or clear) the selected project id. Passing `undefined`/empty removes
 * the selection so the next resolution falls through to flag/env or `undefined`.
 */
export function setSelectedProjectId(id: string | undefined): void {
  const environment = currentEnvironment();
  if (environment) {
    new EnvironmentStore().set(environment.name, "SCOPE_PROJECT", id);
    return;
  }
  const config = readConfig();
  const trimmed = id?.trim();
  if (trimmed) config.selectedProjectId = trimmed;
  else delete config.selectedProjectId;
  writeConfig(config);
}

/**
 * Resolve the active project id following the documented precedence
 * (`--project` → `SCOPE_PROJECT` → persisted config). Returns `undefined` when
 * no source provides one — there is deliberately no default project.
 */
export function resolveProjectId(flag?: string): string | undefined {
  const fromFlag = flag?.trim();
  if (fromFlag) return fromFlag;
  const environment = currentEnvironment();
  if (environment) return environment.project;
  const fromEnv = process.env.SCOPE_PROJECT?.trim();
  if (fromEnv) return fromEnv;
  return getSelectedProjectId();
}

/**
 * Resolve the active project id or throw a clear, actionable error. Use this in
 * commands that cannot operate without a project (scoped lists, root creates).
 */
export function requireProjectId(flag?: string): string {
  const id = resolveProjectId(flag);
  if (!id) {
    const cli = getCliName();
    const environment = currentEnvironment();
    if (environment) {
      throw new Error(
        `No project selected in environment "${environment.name}". Pass --project <id> or run \`${cli} --env ${environment.name} project use <id>\`.`,
      );
    }
    throw new Error(
      `No project selected. Pass --project <id>, set SCOPE_PROJECT, or run \`${cli} project use <id>\`.`,
    );
  }
  return id;
}
