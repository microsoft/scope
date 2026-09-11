// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { discoverACPModels } from "coder-acp-copilot/acp-client";
import { copilotRuntime, type detectCopilot } from "./runtime.js";

export async function discoverCopilot(detected: ReturnType<typeof detectCopilot>, env: NodeJS.ProcessEnv = process.env) {
  const runtime = copilotRuntime(detected, env);
  mkdirSync(runtime.workspaceRoot!, { recursive: true });
  const cwd = mkdtempSync(join(runtime.workspaceRoot!, "discovery-"));
  try {
    return {
      ...detected,
      ...await discoverACPModels({
        command: detected.executable,
        args: ["--acp", "--no-auto-update"],
        env: { COPILOT_AUTO_UPDATE: "false" },
        cwd,
        onLog: () => {},
      }),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
