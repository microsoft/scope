// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceConfig, ResourceScript } from "../types/resource.js";
import { parseResourceEnv, missingExports } from "./resource-env.js";

/**
 * Execution of a resource's lifecycle phases.
 *
 * The setup phase provisions whatever the run needs — typically by starting
 * containers through the Docker socket — and publishes its connection details by
 * appending `KEY=VALUE` lines to `$SCOPE_SETUP_ENV`. The teardown phase releases
 * it again.
 *
 * Only `sh` is executed today. The body is selected by interpreter rather than
 * assumed, so adding PowerShell for the Windows worker stays additive.
 */

/** Default ceiling for one phase. A container pull plus a repo import legitimately takes a minute. */
export const DEFAULT_PHASE_TIMEOUT_MS = 10 * 60_000;

export type LogFn = (level: "info" | "warn" | "error", message: string) => void | Promise<void>;

export interface RunPhaseOptions {
  /** Working directory for the script. Normally the run's workspace. */
  cwd: string;
  /** Extra environment for the script, on top of the worker's own. */
  env?: Record<string, string>;
  timeoutMs?: number;
  log?: LogFn;
  /** Abort in-flight execution (worker shutdown). */
  signal?: AbortSignal;
  /**
   * Path to the run-scoped concealed store, exposed to scripts as
   * `$SCOPE_CONCEALED_ENV`.
   *
   * `$SCOPE_SETUP_ENV` and `$SCOPE_CONCEALED_ENV` are both channels a script
   * publishes to; they differ only in who can see the result. Values written to
   * `$SCOPE_SETUP_ENV` reach the agent's environment, values written here do
   * not — they are for the platform (MCP server interpolation), for later
   * resources, and for tooling wrappers that read them at call time.
   *
   * Unlike `$SCOPE_SETUP_ENV`, which is a fresh per-phase temp file, this one is
   * run-scoped and accumulates, so a resource can read what earlier resources
   * published. The caller owns its lifetime: it must outlive setup, because the
   * agent runs between setup and teardown.
   */
  concealedEnvPath?: string;
}

export interface PhaseResult {
  /** Values the phase published via `$SCOPE_SETUP_ENV`. Empty for teardown. */
  values: Record<string, string>;
  /**
   * Everything in the concealed store after this phase. The store accumulates,
   * so this is the running total rather than this phase's contribution.
   */
  concealed: Record<string, string>;
  exitCode: number;
  durationMs: number;
}

export class ResourcePhaseError extends Error {
  readonly slug: string;
  readonly phase: "setup" | "teardown";
  readonly exitCode: number | null;

  constructor(slug: string, phase: "setup" | "teardown", exitCode: number | null, detail: string) {
    super(`Resource '${slug}' ${phase} failed${exitCode === null ? "" : ` (exit ${exitCode})`}: ${detail}`);
    this.name = "ResourcePhaseError";
    this.slug = slug;
    this.phase = phase;
    this.exitCode = exitCode;
  }
}

/**
 * Pick the body for this platform.
 *
 * Returns undefined when the phase is absent entirely (a resource may legitimately
 * have no teardown). Throws when the phase exists but has no body for this
 * interpreter — that is a misconfiguration, and skipping it silently would give a
 * run that looks valid but has no resource.
 */
export function selectPhaseBody(
  script: ResourceScript | undefined,
  slug: string,
  phase: "setup" | "teardown",
): string | undefined {
  if (!script) return undefined;
  const body = script.sh;
  if (typeof body === "string" && body.length > 0) return body;
  throw new ResourcePhaseError(
    slug,
    phase,
    null,
    `no 'sh' body (declared interpreters: ${Object.keys(script).join(", ") || "none"})`,
  );
}

/** Run one phase body, returning anything it published. */
async function runScript(
  slug: string,
  phase: "setup" | "teardown",
  body: string,
  options: RunPhaseOptions,
): Promise<PhaseResult> {
  const { cwd, env = {}, timeoutMs = DEFAULT_PHASE_TIMEOUT_MS, log, signal, concealedEnvPath } = options;
  const started = Date.now();

  const dir = await mkdtemp(join(tmpdir(), `scope-resource-${slug}-`));
  const scriptPath = join(dir, `${phase}.sh`);
  const envPath = join(dir, "exports.env");

  try {
    await writeFile(scriptPath, body, "utf-8");
    await writeFile(envPath, "", "utf-8");

    const exitCode = await new Promise<number>((resolve, reject) => {
      // `-e` so a failing command aborts the phase rather than continuing into a
      // half-provisioned state that looks successful.
      const child = spawn("sh", ["-e", scriptPath], {
        cwd,
        env: {
          ...process.env,
          ...env,
          SCOPE_SETUP_ENV: envPath,
          // Set after the spreads for the same reason as SCOPE_SETUP_ENV: a
          // resource parameter must not be able to redirect the store.
          ...(concealedEnvPath ? { SCOPE_CONCEALED_ENV: concealedEnvPath } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ResourcePhaseError(slug, phase, null, `timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const stream = (chunk: Buffer, level: "info" | "warn") => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (line.trim() !== "") void log?.(level, `[resource:${slug}:${phase}] ${line}`);
        }
      };
      child.stdout.on("data", (c: Buffer) => stream(c, "info"));
      child.stderr.on("data", (c: Buffer) => stream(c, "warn"));

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new ResourcePhaseError(slug, phase, null, err.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    if (exitCode !== 0) {
      throw new ResourcePhaseError(slug, phase, exitCode, "see the run log for script output");
    }

    const contents = await readFile(envPath, "utf-8");
    const { values, errors } = parseResourceEnv(contents);
    if (errors.length > 0) {
      const detail = errors.map((e) => `line ${e.line}: ${e.reason}`).join("; ");
      throw new ResourcePhaseError(slug, phase, exitCode, `malformed $SCOPE_SETUP_ENV — ${detail}`);
    }

    let concealed: Record<string, string> = {};
    if (concealedEnvPath) {
      const concealedContents = await readFile(concealedEnvPath, "utf-8").catch(() => "");
      const parsed = parseResourceEnv(concealedContents);
      if (parsed.errors.length > 0) {
        const detail = parsed.errors.map((e) => `line ${e.line}: ${e.reason}`).join("; ");
        throw new ResourcePhaseError(
          slug,
          phase,
          exitCode,
          `malformed $SCOPE_CONCEALED_ENV — ${detail}`,
        );
      }
      concealed = parsed.values;
    }

    return { values, concealed, exitCode, durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Overlay a resource's resolved parameter values onto the phase environment.
 *
 * Precedence, widest to narrowest: `process.env` (applied inside `runScript`),
 * then the resource's parameters, then the caller's `env`, then
 * `SCOPE_SETUP_ENV`.
 *
 * Caller-supplied `env` deliberately wins over parameters. It carries worker
 * infrastructure such as `DOCKER_HOST`, and a resource declaring a parameter
 * that happened to share one of those names would otherwise redirect the Docker
 * socket rather than configure itself. `SCOPE_*` is already refused at
 * declaration time for the same reason.
 */
function withParams(options: RunPhaseOptions, resource: ResourceConfig): RunPhaseOptions {
  if (!resource.params || Object.keys(resource.params).length === 0) return options;
  return { ...options, env: { ...resource.params, ...(options.env ?? {}) } };
}

/**
 * Create the run-scoped concealed store.
 *
 * Separate from `runResourceSetups` because its lifetime spans the whole run:
 * setup writes it, the agent's tooling wrappers read it while the agent works,
 * and teardown still needs it. The caller disposes of it once teardown is done.
 *
 * Mode 0600 is honest housekeeping rather than isolation — the agent runs as the
 * same uid as resource setup, so POSIX cannot hide it from that process. What the
 * store buys is that the values are absent from the agent's *environment*, which
 * is where tooling looks first.
 */
export async function createConcealedStore(): Promise<{ path: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "scope-concealed-"));
  const path = join(dir, "concealed.env");
  await writeFile(path, "", { encoding: "utf-8", mode: 0o600 });
  return {
    path,
    dispose: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Provision every resource, in reference order.
 *
 * Returns the merged published values. On failure, the caller is responsible for
 * tearing down whatever already succeeded. Because a throw discards the return
 * value entirely, the attempted prefix is reported through `onProvisioned` as it
 * grows rather than only in the result — a caller that waited for the result
 * would unwind nothing on exactly the paths that need unwinding.
 */
export async function runResourceSetups(
  resources: ResourceConfig[],
  options: RunPhaseOptions & { onProvisioned?: (resource: ResourceConfig) => void },
): Promise<{
  values: Record<string, string>;
  concealed: Record<string, string>;
  provisioned: ResourceConfig[];
}> {
  const values: Record<string, string> = {};
  let concealed: Record<string, string> = {};
  const provisioned: ResourceConfig[] = [];

  for (const resource of resources) {
    const body = selectPhaseBody(resource.setup, resource.slug, "setup");
    if (!body) {
      throw new ResourcePhaseError(resource.slug, "setup", null, "resource has no setup phase");
    }

    void options.log?.("info", `Provisioning resource '${resource.slug}' (${resource.ref})`);
    // Marked provisioned before running: a phase that fails partway may still
    // have created containers, so its teardown must run. Reported immediately so
    // the caller can unwind this resource even though the throw below would
    // discard the returned list.
    provisioned.push(resource);
    options.onProvisioned?.(resource);
    const result = await runScript(resource.slug, "setup", body, withParams(options, resource));

    const missing = missingExports(resource.exports, result.values);
    if (missing.length > 0) {
      throw new ResourcePhaseError(
        resource.slug,
        "setup",
        result.exitCode,
        `did not publish declared exports: ${missing.join(", ")}`,
      );
    }

    Object.assign(values, result.values);
    // The store accumulates, so this is the running total rather than a merge of
    // one resource's contribution.
    concealed = result.concealed;
    void options.log?.(
      "info",
      `Resource '${resource.slug}' ready in ${result.durationMs}ms` +
        (resource.exports.length > 0 ? ` (published ${resource.exports.join(", ")})` : ""),
    );
  }

  return { values, concealed, provisioned };
}

/**
 * Release resources in **reverse** order, so dependants unwind before their
 * dependencies.
 *
 * Teardown is best-effort: a failure is logged and the remaining resources are
 * still released. Letting cleanup failure change the run's reported outcome would
 * mask the result the run actually produced.
 */
export async function runResourceTeardowns(
  resources: ResourceConfig[],
  options: RunPhaseOptions,
): Promise<void> {
  for (const resource of [...resources].reverse()) {
    let body: string | undefined;
    try {
      body = selectPhaseBody(resource.teardown, resource.slug, "teardown");
    } catch (err) {
      void options.log?.("warn", `Resource '${resource.slug}' teardown skipped: ${String(err)}`);
      continue;
    }
    if (!body) continue;

    try {
      void options.log?.("info", `Releasing resource '${resource.slug}'`);
      await runScript(resource.slug, "teardown", body, withParams(options, resource));
    } catch (err) {
      void options.log?.(
        "warn",
        `Resource '${resource.slug}' teardown failed, continuing: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
