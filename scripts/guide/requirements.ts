// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// requirements.ts — Prerequisite checks run before a recipe
// =============================================================================
// Checks are presence-only and read-only: they look for tools on PATH, probe
// the Docker daemon, and look for credential variables without ever printing
// their values. All system access goes through CheckContext so tests can fake it.
// =============================================================================

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseEnv } from "node:util";

export type RequirementId =
  | "node"
  | "docker"
  | "mkcert"
  | "github-token"
  | "anthropic-key"
  | "cargo"
  | "env-file"
  | "packages-built"
  | "devcontainer";

/** `warn` never blocks; `fail` asks the user before continuing when the requirement is mandatory. */
export type CheckStatus = "ok" | "warn" | "fail";

/** Offer to fix a missing credential for this run only, with the user's consent. */
export interface CredentialOffer {
  /** Yes/no question shown to the user. */
  question: string;
  /** Obtain the variables to add to the child process environment, or `undefined` on failure. Values are never printed or stored. */
  resolve(): Record<string, string> | undefined;
}

/** Outcome of one prerequisite check. */
export interface CheckResult {
  id: RequirementId;
  /** Human-readable name, e.g. "Docker". */
  label: string;
  status: CheckStatus;
  /** What was found. Never contains secret values. */
  detail: string;
  /** How to fix a `warn` or `fail`. */
  fix?: string;
  offer?: CredentialOffer;
}

/** Everything a check may read from the system; injectable for tests. */
export interface CheckContext {
  /** Process environment of the guide. */
  env: NodeJS.ProcessEnv;
  /** Node.js version, e.g. "22.22.0". */
  nodeVersion: string;
  /** Whether an executable is on PATH. */
  onPath(command: string): boolean;
  /** Whether a command exits with status 0 (output discarded). */
  succeeds(command: string, args: string[]): boolean;
  /** A command's trimmed stdout, or `undefined` if it fails. */
  output(command: string, args: string[]): string | undefined;
  /** Contents of a file relative to the repository root, or `undefined` if missing. */
  readFile(relativePath: string): string | undefined;
}

/** Commands like `docker info` can hang when the daemon is wedged; never wait longer than this. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Create the real {@link CheckContext} for a repository checkout.
 *
 * @param root - Absolute repository root; `readFile` paths are relative to it.
 * @param env - Environment used for PATH lookup and credential checks (default: process.env).
 */
export function createCheckContext(root: string, env: NodeJS.ProcessEnv = process.env): CheckContext {
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];

  return {
    env,
    nodeVersion: process.versions.node,
    onPath(command) {
      const directories = (env.PATH ?? "").split(delimiter).filter(Boolean);
      return directories.some((directory) => extensions.some((extension) => existsSync(join(directory, command + extension))));
    },
    succeeds(command, args) {
      try {
        execFileSync(command, args, { stdio: "ignore", timeout: PROBE_TIMEOUT_MS, env });
        return true;
      } catch {
        return false;
      }
    },
    output(command, args) {
      try {
        return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: PROBE_TIMEOUT_MS, env }).trim();
      } catch {
        return undefined;
      }
    },
    readFile(relativePath) {
      const path = join(root, relativePath);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
  };
}

/**
 * Find a variable the way the Compose scripts see it: the shell environment
 * wins, then `.env.local` (personal overrides), then the generated `.env`.
 *
 * @returns Where the non-empty value was found, or `undefined`.
 */
export function findVariable(context: CheckContext, name: string): "shell" | ".env.local" | ".env" | undefined {
  if (context.env[name]) return "shell";

  for (const file of [".env.local", ".env"] as const) {
    const content = context.readFile(file);
    if (content !== undefined && parseEnv(content)[name]) return file;
  }
  return undefined;
}

/** Node.js 22 is what CI builds and tests with; other versions usually work but are unsupported. */
function checkNode(context: CheckContext): CheckResult {
  const major = Number(context.nodeVersion.split(".")[0]);
  const base = { id: "node", label: "Node.js 22" } as const;

  if (major === 22) return { ...base, status: "ok", detail: `Node.js ${context.nodeVersion}` };
  return { ...base, status: "warn", detail: `Node.js ${context.nodeVersion} (CI uses Node.js 22)`, fix: "Install Node.js 22, for example with nvm or fnm." };
}

/** Docker must be installed, its daemon reachable, and Compose v2 available. */
function checkDocker(context: CheckContext): CheckResult {
  const base = { id: "docker", label: "Docker" } as const;

  if (!context.onPath("docker")) {
    return { ...base, status: "fail", detail: "docker is not installed", fix: "Install Docker Desktop or Docker Engine with Compose v2." };
  }
  if (!context.succeeds("docker", ["info"])) {
    return { ...base, status: "fail", detail: "the Docker daemon is not reachable", fix: "Start Docker Desktop or the Docker daemon, then try again." };
  }
  if (!context.succeeds("docker", ["compose", "version"])) {
    return { ...base, status: "fail", detail: "Docker Compose v2 is missing", fix: "Install the Docker Compose v2 plugin (docker compose)." };
  }
  return { ...base, status: "ok", detail: "daemon running, Compose v2 available" };
}

/** mkcert creates the trusted certificates used by the local sign-in emulator. */
function checkMkcert(context: CheckContext): CheckResult {
  const base = { id: "mkcert", label: "mkcert" } as const;

  if (context.onPath("mkcert")) return { ...base, status: "ok", detail: "installed" };
  return { ...base, status: "fail", detail: "mkcert is not installed", fix: "Install it: https://github.com/FiloSottile/mkcert#installation" };
}

/**
 * The Copilot worker needs GITHUB_TOKEN from an account with an active Copilot
 * entitlement. When only the GitHub CLI is signed in, offer to pass its token
 * to this run instead of asking the user to export it.
 */
function checkGitHubToken(context: CheckContext): CheckResult {
  const base = { id: "github-token", label: "GITHUB_TOKEN" } as const;
  const entitlement = "The account needs an active GitHub Copilot entitlement.";

  const source = findVariable(context, "GITHUB_TOKEN");
  if (source) return { ...base, status: "ok", detail: `set (${source === "shell" ? "shell environment" : source})` };

  const exportHint = `export GITHUB_TOKEN="$(gh auth token)" or add GITHUB_TOKEN to .env.local. ${entitlement}`;
  if (context.onPath("gh") && context.succeeds("gh", ["auth", "token"])) {
    return {
      ...base,
      status: "fail",
      detail: "not set, but the GitHub CLI is signed in",
      fix: `Run ${exportHint}`,
      offer: {
        question: "Use your GitHub CLI login (gh auth token) as GITHUB_TOKEN for this run?",
        resolve: () => {
          const token = context.output("gh", ["auth", "token"]);
          return token ? { GITHUB_TOKEN: token } : undefined;
        },
      },
    };
  }

  return { ...base, status: "fail", detail: "not set", fix: `Sign in with gh auth login, then ${exportHint}` };
}

/** The Claude Code worker reads ANTHROPIC_API_KEY. */
function checkAnthropicKey(context: CheckContext): CheckResult {
  const base = { id: "anthropic-key", label: "ANTHROPIC_API_KEY" } as const;

  const source = findVariable(context, "ANTHROPIC_API_KEY");
  if (source) return { ...base, status: "ok", detail: `set (${source === "shell" ? "shell environment" : source})` };
  return { ...base, status: "fail", detail: "not set", fix: "Export ANTHROPIC_API_KEY in your shell or add it to .env.local (never to .env.base)." };
}

/** Rust is only needed for the AI gateway. */
function checkCargo(context: CheckContext): CheckResult {
  const base = { id: "cargo", label: "Rust (cargo)" } as const;

  if (context.onPath("cargo")) return { ...base, status: "ok", detail: "installed" };
  return { ...base, status: "fail", detail: "cargo is not installed", fix: "Install Rust with rustup: https://rustup.rs" };
}

/** Some test suites load the worktree-specific `.env` generated by the Docker scripts. */
function checkEnvFile(context: CheckContext): CheckResult {
  const base = { id: "env-file", label: ".env file" } as const;

  if (context.readFile(".env") !== undefined) return { ...base, status: "ok", detail: "present" };
  return { ...base, status: "fail", detail: "missing", fix: "Generate it by running a Docker command once, e.g. pnpm docker:up:infra." };
}

/**
 * Apps run natively with tsx import workspace packages (e.g. `shared`) from
 * their `dist/` output, which a fresh install does not build. The shared
 * package's build output stands in for all of them.
 */
function checkPackagesBuilt(context: CheckContext): CheckResult {
  const base = { id: "packages-built", label: "Built workspace packages" } as const;

  if (context.readFile("packages/shared/dist/index.js") !== undefined) return { ...base, status: "ok", detail: "packages/shared/dist present" };
  return {
    ...base,
    status: "fail",
    detail: "packages/shared/dist is missing",
    fix: 'Build them once, and again after changing packages/: pnpm -r --filter "./packages/**" --if-present build',
  };
}

/** The devcontainer sets SCOPE_DIND_SPIKE; the dev:* commands are designed for it. */
function checkDevcontainer(context: CheckContext): CheckResult {
  const base = { id: "devcontainer", label: "Scope devcontainer" } as const;

  if (context.env.SCOPE_DIND_SPIKE === "1") return { ...base, status: "ok", detail: "running inside the devcontainer" };
  return { ...base, status: "warn", detail: "not running inside the Scope devcontainer", fix: "Reopen the repository in the devcontainer; see docs/architecture/devcontainer.md." };
}

const CHECKS: Record<RequirementId, (context: CheckContext) => CheckResult> = {
  node: checkNode,
  docker: checkDocker,
  mkcert: checkMkcert,
  "github-token": checkGitHubToken,
  "anthropic-key": checkAnthropicKey,
  cargo: checkCargo,
  "env-file": checkEnvFile,
  "packages-built": checkPackagesBuilt,
  devcontainer: checkDevcontainer,
};

/** Run one prerequisite check. */
export function checkRequirement(id: RequirementId, context: CheckContext): CheckResult {
  return CHECKS[id](context);
}

/** Run several checks once each, in the given order. */
export function checkRequirements(ids: readonly RequirementId[], context: CheckContext): CheckResult[] {
  return [...new Set(ids)].map((id) => checkRequirement(id, context));
}
