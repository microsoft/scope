// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { discoverACPModels } from "coder-acp-copilot/acp-client";
import { claudeCodeRuntime, type DetectedClaudeCodeHost } from "./runtime.js";

/**
 * Open a throwaway ACP session to read Claude Code's native model catalog.
 *
 * Discovery uses the same adapter wiring as real runs but does not send a user
 * prompt, so it verifies login/model availability without consuming work items.
 */
export async function discoverClaudeCode(
  detected: DetectedClaudeCodeHost,
  env: NodeJS.ProcessEnv = process.env,
) {
  const runtime = claudeCodeRuntime(detected, env);
  mkdirSync(runtime.workspaceRoot!, { recursive: true });
  const cwd = mkdtempSync(join(runtime.workspaceRoot!, "discovery-"));
  try {
    return {
      ...detected,
      ...await discoverACPModels({
        command: runtime.command!,
        args: runtime.args,
        env: runtime.env,
        cwd,
        onLog: () => {},
      }),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
