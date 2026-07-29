// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execSync } from "node:child_process";

/**
 * Detect the version of a globally-installed CLI binary by running `<command> --version`
 * and parsing the output. The result is cached so the binary is only spawned once.
 *
 * @param command  The CLI command name (e.g. "copilot", "claude-agent-acp")
 * @param packageName  npm package name prefix (e.g. "@github/copilot", "@agentclientprotocol/claude-agent-acp")
 * @returns A version string like "@github/copilot@0.0.415" or "unknown" on failure
 */
export function detectCliVersion(command: string, packageName: string): string {
  try {
    const raw = execSync(`${command} --version`, {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    // Extract a semver-like version (digits.digits.digits with optional pre-release)
    const match = raw.match(/(\d+\.\d+\.\d+[\w.-]*)/);
    if (match) {
      return `${packageName}@${match[1]}`;
    }
    // Fallback: return the raw output if short enough
    return raw.length <= 100 ? `${packageName}@${raw}` : "unknown";
  } catch {
    return "unknown";
  }
}
