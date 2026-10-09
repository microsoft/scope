// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { ClaudeCodeWorkerRuntime } from "coder-acp-claude-code/worker";

/** Worker ID registered by the local server for host-side Claude Code execution. */
export const WORKER_TYPE = "coder-acp-claude-code-host";
const require = createRequire(import.meta.url);

/** Detection payload consumed by the launcher before it registers this host worker. */
export interface DetectedClaudeCodeHost {
  workerType: string;
  executable: string;
  version: string;
  adapter: string;
  agentVersion: string;
  componentVersions: Record<string, string>;
}

interface ClaudeAgentAdapterPackage {
  version: string;
  bin: Record<string, string>;
  dependencies: Record<string, string>;
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

/** Locate the installed Claude Code CLI and the bundled ACP adapter. */
export function detectClaudeCode(env: NodeJS.ProcessEnv = process.env): DetectedClaudeCodeHost {
  const command = env.SCOPE_HOST_EXECUTABLE || env.CLAUDE_CODE_EXECUTABLE || "claude";
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
      `Claude Code CLI not found: ${command}. Install a compatible CLI and log in before enabling this host worker.`,
    );
  }

  const options = {
    encoding: "utf8" as const,
    timeout: 15_000,
    env,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  const versionOutput = execFileSync(executable, ["--version"], options);
  const help = execFileSync(executable, ["--help"], options);
  const version = versionOutput.match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\b/)?.[1];
  const requiredFlags = [
    "--input-format",
    "--output-format",
    "--permission-mode",
    "stream-json",
    "--strict-mcp-config",
  ];
  if (!version || !versionOutput.includes("Claude Code") || !requiredFlags.every((flag) => help.includes(flag))) {
    throw new Error(
      "Installed Claude Code must support stream-json input/output, permission modes, " +
      "and --strict-mcp-config. Update it yourself; Scope does not install or upgrade host CLIs.",
    );
  }

  const packagePath = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
  const adapterPackage: ClaudeAgentAdapterPackage = JSON.parse(readFileSync(packagePath, "utf8"));
  const adapter = resolve(dirname(packagePath), adapterPackage.bin["claude-agent-acp"]);
  accessSync(adapter, constants.R_OK);
  return {
    workerType: WORKER_TYPE,
    executable,
    version,
    adapter,
    agentVersion: `claude-code-${version}-acp-${adapterPackage.version}`,
    componentVersions: {
      CLAUDE_CODE_VERSION: version,
      CLAUDE_CODE_ACP_VERSION: adapterPackage.version,
      CLAUDE_AGENT_SDK_VERSION: adapterPackage.dependencies["@anthropic-ai/claude-agent-sdk"],
    },
  };
}

/**
 * Build the runtime contract for the shared Claude worker implementation.
 *
 * HOME and CLAUDE_CONFIG_DIR are deliberately left alone so the installed CLI
 * can reuse its login. Reproducibility is enforced by ACP metadata that excludes
 * personal settings/MCP sources and by --strict-mcp-config, not by moving HOME.
 */
export function claudeCodeRuntime(
  detected: DetectedClaudeCodeHost,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCodeWorkerRuntime {
  const workspaceRoot = env.SCOPE_HOST_WORKSPACE_ROOT;
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) {
    throw new Error("SCOPE_HOST_WORKSPACE_ROOT must be an absolute, dedicated directory for this host worker.");
  }
  assertNoInheritedProxyConflict(env);
  return {
    workerName: WORKER_TYPE,
    command: process.execPath,
    args: [detected.adapter],
    env: { CLAUDE_CODE_EXECUTABLE: detected.executable, DISABLE_AUTOUPDATER: "1" },
    agentVersion: detected.agentVersion,
    componentVersions: detected.componentVersions,
    workspaceRoot,
    hostLogin: true,
    isolateHostConfig: true,
    captureProxy: true,
  };
}
