// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { discoverACPModels } from "coder-acp-copilot/acp-client";
import { claudeCodeRuntime, type detectClaudeCode } from "./runtime.js";

export async function discoverClaudeCode(detected: ReturnType<typeof detectClaudeCode>, env: NodeJS.ProcessEnv = process.env) {
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
