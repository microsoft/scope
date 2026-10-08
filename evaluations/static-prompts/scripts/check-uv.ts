// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REQUIRED_UV_VERSION = "0.10.0";

interface CommandResult {
  error?: NodeJS.ErrnoException;
  status: number | null;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
) => CommandResult;

export function uvInstallGuidance(platform: NodeJS.Platform): string {
  const platformCommand =
    platform === "win32"
      ? "winget install --id=astral-sh.uv -e"
      : platform === "darwin"
        ? "brew install uv"
        : "curl -LsSf https://astral.sh/uv/install.sh | sh";

  return [
    `Static prompt evaluations require Astral uv ${REQUIRED_UV_VERSION}.`,
    "",
    `Install uv: ${platformCommand}`,
    "Official instructions: https://docs.astral.sh/uv/getting-started/installation/",
    "",
    "Then prepare the evaluation environment with:",
    "  pnpm --filter static-prompt-evals setup:python",
  ].join("\n");
}

export function checkUv(
  runCommand: CommandRunner = (command, args) =>
    spawnSync(command, args, { stdio: "ignore" }),
): boolean {
  const result = runCommand("uv", ["--version"]);
  return result.status === 0 && result.error === undefined;
}

function main(): void {
  if (checkUv()) {
    return;
  }
  console.error(uvInstallGuidance(process.platform));
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
