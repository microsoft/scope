// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { discoverACPModels } from "coder-acp-copilot/acp-client";
import { copilotRuntime, type DetectedCopilotHost } from "./runtime.js";

/**
 * Open a throwaway ACP session to read Copilot's native model catalog.
 *
 * Discovery uses a temporary workspace under the dedicated host worker root so
 * it never probes from the user's shell cwd and can be deleted afterward.
 */
export async function discoverCopilot(
  detected: DetectedCopilotHost,
  env: NodeJS.ProcessEnv = process.env,
) {
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
