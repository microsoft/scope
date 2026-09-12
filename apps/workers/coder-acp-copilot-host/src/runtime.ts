// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { CopilotWorkerRuntime } from "coder-acp-copilot/worker";

/** Worker ID registered by the local server for host-side Copilot execution. */
export const WORKER_TYPE = "coder-acp-copilot-host";

/** Detection payload consumed by the launcher before it registers this host worker. */
export interface DetectedCopilotHost {
  workerType: string;
  executable: string;
  version: string;
  agentVersion: string;
  componentVersions: Record<string, string>;
}

const inheritedProxyKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

function assertNoInheritedProxyConflict(env: NodeJS.ProcessEnv): void {
  const key = inheritedProxyKeys.find((candidate) => env[candidate]);
  if (!key) return;
  throw new Error(
    `Scope host HAR capture cannot run while ${key} is already set. ` +
    "Start Scope Server from a shell without HTTP_PROXY/HTTPS_PROXY/ALL_PROXY, " +
    "or configure that upstream proxy outside Scope; the local gateway proxy cannot be silently bypassed.",
  );
}

/** Locate and validate the user's installed Copilot CLI without modifying it. */
export function detectCopilot(env: NodeJS.ProcessEnv = process.env): DetectedCopilotHost {
  const command = env.SCOPE_HOST_EXECUTABLE || "copilot";
  const candidates = isAbsolute(command) || command.includes("/")
    ? [resolve(command)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  const executable = candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!executable) {
    throw new Error(
      `Copilot CLI not found: ${command}. Install a compatible CLI and log in before enabling this host worker.`,
    );
  }

  const options = {
    encoding: "utf8" as const,
    timeout: 15_000,
    env: { ...env, COPILOT_AUTO_UPDATE: "false" },
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  const versionOutput = execFileSync(executable, ["--version"], options);
  const help = execFileSync(executable, ["--help"], options);
  const version = versionOutput.match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\b/)?.[1];
  const requiredFlags = [
    "--acp",
    "--yolo",
    "--no-auto-update",
    "--disable-builtin-mcps",
    "--disable-mcp-server",
    "--additional-mcp-config",
  ];
  if (!version || !requiredFlags.every((flag) => help.includes(flag))) {
    throw new Error(
      "Installed Copilot CLI must support native --acp, --yolo, --no-auto-update, " +
      "MCP disabling flags, and --additional-mcp-config. Update it yourself; " +
      "Scope does not install or upgrade host CLIs.",
    );
  }
  return {
    workerType: WORKER_TYPE,
    executable,
    version,
    agentVersion: `copilot-${version}`,
    componentVersions: { COPILOT_CLI_VERSION: version },
  };
}

/**
 * Build the runtime contract for the shared Copilot worker implementation.
 *
 * HOME is deliberately not relocated: doing so would break reuse of the user's
 * existing Copilot login. Reproducibility instead comes from disabling personal
 * MCP servers/settings in the worker while keeping the installed CLI identity.
 */
export function copilotRuntime(
  detected: DetectedCopilotHost,
  env: NodeJS.ProcessEnv = process.env,
): CopilotWorkerRuntime {
  const workspaceRoot = env.SCOPE_HOST_WORKSPACE_ROOT;
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) {
    throw new Error("SCOPE_HOST_WORKSPACE_ROOT must be an absolute, dedicated directory for this host worker.");
  }
  assertNoInheritedProxyConflict(env);
  return {
    workerName: WORKER_TYPE,
    command: detected.executable,
    agentVersion: detected.agentVersion,
    componentVersions: detected.componentVersions,
    workspaceRoot,
    hostLogin: true,
    isolateHostConfig: true,
    captureProxy: true,
  };
}
