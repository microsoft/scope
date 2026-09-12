// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentSettings } from "./agents.js";
import type { TargetId } from "./manifest.js";

const exec = promisify(execFile);

/** Host executable metadata returned by a worker's cheap --detect probe. */
export interface DetectedHost {
  workerType: string;
  executable: string;
  version: string;
  agentVersion: string;
  componentVersions: Record<string, string>;
}

/** Full ACP model catalog returned by --discover before a host worker is enabled. */
export interface DiscoveredHost extends DetectedHost {
  supportedModels: string[];
  models: Array<{ id: string; name?: string }>;
  defaultModel?: string;
}

/** Validate the --detect JSON emitted by a packaged host worker. */
export function parseDetectedHost(value: unknown): DetectedHost {
  if (
    typeof value !== "object" || value === null ||
    !["workerType", "executable", "version", "agentVersion"].every(key =>
      key in value && typeof Reflect.get(value, key) === "string") ||
    !("componentVersions" in value) ||
    typeof value.componentVersions !== "object" ||
    value.componentVersions === null ||
    !Object.values(value.componentVersions).every(version => typeof version === "string")
  ) {
    throw new Error("Host worker returned invalid detection output");
  }
  return value as DetectedHost;
}

/** Validate model discovery and fill legacy model metadata when ACP only returns IDs. */
export function parseDiscoveredHost(value: unknown): DiscoveredHost {
  const detected = parseDetectedHost(value);
  if (
    typeof value !== "object" || value === null ||
    !("supportedModels" in value) ||
    !Array.isArray(value.supportedModels) ||
    value.supportedModels.length === 0 ||
    !value.supportedModels.every((id: unknown) => typeof id === "string" && id.length > 0)
  ) {
    throw new Error("Host worker did not advertise a valid ACP model catalog");
  }
  const supportedModels = value.supportedModels as string[];
  if (
    "defaultModel" in value &&
    (typeof value.defaultModel !== "string" || !supportedModels.includes(value.defaultModel))
  ) {
    throw new Error("Host worker did not advertise a valid ACP model catalog");
  }
  if (!("models" in value)) {
    return { ...detected, ...value, models: supportedModels.map(id => ({ id })) } as DiscoveredHost;
  }
  if (
    !Array.isArray(value.models) ||
    value.models.length === 0 ||
    !value.models.every((model: unknown) => typeof model === "object" && model !== null &&
      "id" in model && typeof model.id === "string" && supportedModels.includes(model.id) &&
      (!("name" in model) || typeof model.name === "string"))
  ) {
    throw new Error("Host worker did not advertise a valid ACP model catalog");
  }
  const models = value.models as Array<{ id: string; name?: string }>;
  if (supportedModels.some(id => !models.some(model => model.id === id))) {
    throw new Error("ACP model metadata is incomplete");
  }
  return { ...detected, ...value } as DiscoveredHost;
}

/**
 * Signal the host worker process group so child CLIs do not keep consuming queues.
 *
 * Host workers spawn installed tools that may themselves create process trees.
 * On Unix the supervisor starts a process group and signals it as a unit; on
 * Windows it falls back to the direct child because negative PIDs are unsupported.
 */
export function signalHostProcess(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
  grouped = process.platform !== "win32",
): void {
  if (child.pid === undefined) return;
  try {
    if (grouped) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/**
 * Resolve the legacy capture toggle for host workers.
 *
 * The gateway backend still reuses DEV_PROXY_ENABLED/DEV_PROXY_API_URL, and the
 * worker treats any nonempty DEV_PROXY_ENABLED value as enabled.
 */
export function hostCaptureSetting(env: NodeJS.ProcessEnv): string {
  // Existing workers enable capture for any nonempty value, including "false".
  return env.DEV_PROXY_ENABLED ?? (env.DEV_PROXY_API_URL ? "true" : "");
}

/** Detect the explicit cancellation markers that should be restarted quietly. */
export function isHostCancellation(output: string, id: TargetId): boolean {
  return output.split("\n").some(line => line.includes(`[${id}] Run `) && (
    line.trimEnd().endsWith(" cancelled via pub/sub — exiting process") ||
    line.trimEnd().endsWith(" cancel detected via key fallback — exiting process")
  ));
}

/** Supervises host workers that run installed CLIs outside Docker. */
export class HostWorkers {
  private readonly children = new Map<TargetId, ChildProcess>();
  /**
   * Monotonic start generation per worker.
   *
   * A slow detect/start sequence can finish after the user disabled the target,
   * or after a newer setup attempt has begun. The generation check makes those
   * stale continuations fail instead of re-registering an older process.
   */
  private readonly generations = new Map<TargetId, number>();
  constructor(
    private readonly dist: string,
    private readonly data: string,
    private readonly onFailure: (id: TargetId, message: string) => void,
  ) {}

  private environment(id: TargetId, settings: AgentSettings, backend: Record<string, string>): NodeJS.ProcessEnv {
    const captureEnv = { ...process.env, ...backend };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...backend,
      SCOPE_HOST_WORKSPACE_ROOT: join(this.data, "workspaces", id),
      TMPDIR: join(this.data, "runtime", id),
      TMP: join(this.data, "runtime", id),
      TEMP: join(this.data, "runtime", id),
      ...(settings.executable ? { SCOPE_HOST_EXECUTABLE: settings.executable } : {}),
      NODE_ENV: "development",
      DEV_PROXY_ENABLED: hostCaptureSetting(captureEnv),
    };
    // The server containers set NODE_TLS_REJECT_UNAUTHORIZED=0 for Lowkey Vault
    // emulation. Host workers run the user's installed CLI, so that container-only
    // relaxation must never weaken TLS for their normal workstation traffic.
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    return env;
  }

  /** Run the cheap executable/version probe for a host target. */
  async detect(id: TargetId, settings: AgentSettings, backend: Record<string, string>): Promise<DetectedHost> {
    await mkdir(join(this.data, "runtime", id), { recursive: true, mode: 0o700 });
    const { stdout } = await exec(process.execPath, [join(this.dist, `${id}.js`), "--detect"], {
      env: this.environment(id, settings, backend),
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    });
    const value: unknown = JSON.parse(stdout);
    const detected = parseDetectedHost(value);
    if (detected.workerType !== id) {
      throw new Error(`Host detection returned the wrong worker type: ${detected.workerType}`);
    }
    return detected;
  }

  /** Probe ACP model metadata before registering the host worker as available. */
  async discover(id: TargetId, settings: AgentSettings, backend: Record<string, string>): Promise<DiscoveredHost> {
    await mkdir(join(this.data, "runtime", id), { recursive: true, mode: 0o700 });
    const { stdout } = await exec(process.execPath, [join(this.dist, `${id}.js`), "--discover"], {
      env: this.environment(id, settings, backend),
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    });
    const discovered = parseDiscoveredHost(JSON.parse(stdout) as unknown);
    if (discovered.workerType !== id) {
      throw new Error(`Host discovery returned the wrong worker type: ${discovered.workerType}`);
    }
    return discovered;
  }

  /** Start a queue worker and wait for the same readiness markers used by Docker workers. */
  async start(id: TargetId, settings: AgentSettings, backend: Record<string, string>): Promise<void> {
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    await mkdir(join(this.data, "workspaces", id), { recursive: true, mode: 0o700 });
    await mkdir(join(this.data, "runtime", id), { recursive: true, mode: 0o700 });
    if (this.generations.get(id) !== generation) throw new Error(`${id} startup cancelled`);
    const child = spawn(process.execPath, [
      "--import",
      join(this.dist, "host-lifecycle.js"),
      join(this.dist, `${id}.js`),
    ], {
      cwd: this.data,
      env: {
        ...this.environment(id, settings, backend),
        SCOPE_HOST_PROCESS_GROUP: String(process.platform !== "win32"),
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.children.set(id, child);
    let output = "";
    let stdout = "";
    const record = (message: string): void => {
      output = `${output}${message}`.slice(-8192);
      process.stdout.write(`[${id}] ${message}`);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (message: string) => {
      stdout = `${stdout}${message}`.slice(-8192);
      record(message);
    });
    child.stderr?.on("data", record);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`${id} startup timed out.\n${output}`));
      }, 90_000);
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.off("error", failed);
        child.off("exit", exited);
        child.stdout?.off("data", checkStartup);
      };
      const failed = (error: Error): void => { cleanup(); reject(error); };
      const exited = (code: number | null): void => {
        cleanup();
        reject(new Error(`${id} exited (${code}).\n${output}`));
      };
      // Existing workers log both messages after queue creation and the database connection.
      const checkStartup = (): void => {
        if (stdout.includes(`[${id}] Ensured queue exists:`) && stdout.includes(`[${id}] Connected to MongoDB`)) {
          cleanup();
          resolve();
        }
      };
      child.once("error", failed);
      child.once("exit", exited);
      child.stdout?.on("data", checkStartup);
    }).catch(async (error: unknown) => { await this.stop(id); throw error; });
    child.once("exit", () => {
      if (this.children.get(id) === child) {
        try { signalHostProcess(child, "SIGKILL"); }
        catch (error) {
          this.children.delete(id);
          this.onFailure(
            id,
            `Failed to stop ${id} subprocesses: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
    // "close" follows stdout draining, so the final cancellation marker is available.
    child.once("close", code => {
      if (this.children.get(id) === child) {
        this.children.delete(id);
        if (code === 0 || (code === 1 && isHostCancellation(stdout, id))) {
          setTimeout(() => {
            if (this.generations.get(id) !== generation) return;
            void this.start(id, settings, backend).catch((error: unknown) => {
              this.onFailure(id, error instanceof Error ? error.message : String(error));
            });
          }, 500).unref();
        } else {
          this.onFailure(id, `${id} exited (${code}).\n${output}`);
        }
      }
    });
  }

  /** Stop a host worker and then kill any descendants left by the installed CLI. */
  async stop(id: TargetId): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const child = this.children.get(id);
    if (!child) return;
    this.children.delete(id);
    if (child.pid === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      signalHostProcess(child, "SIGKILL");
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { signalHostProcess(child, "SIGKILL"); } catch (error) { reject(error); }
      }, 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        try { signalHostProcess(child, "SIGKILL"); resolve(); } catch (error) { reject(error); }
      });
      try { signalHostProcess(child, "SIGTERM"); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  }
}
