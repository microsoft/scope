// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { copilotRuntime, detectCopilot, WORKER_TYPE } from "./runtime.js";

async function main(): Promise<void> {
  const detected = detectCopilot();
  if (process.argv.includes("--discover")) {
    const { discoverCopilot } = await import("./discovery.js");
    console.log(JSON.stringify(await discoverCopilot(detected)));
    return;
  }
  if (process.argv.includes("--detect")) {
    console.log(JSON.stringify(detected));
    return;
  }
  const runtime = copilotRuntime(detected);
  // HAR capture must not replace the host login with Token Manager credentials.
  process.env.GATEWAY_TOKEN_PLUGIN_ENABLED = "false";
  // The registry identity must match the version the launcher registered for this host CLI.
  process.env.SCOPE_AGENT_VERSION = runtime.agentVersion;
  const { startCopilotWorker } = await import("coder-acp-copilot/worker");
  await startCopilotWorker(runtime);
}

main().catch((error: unknown) => {
  console.error(`${WORKER_TYPE} failed:`, error instanceof Error ? error.message : String(error));
  process.exit(1);
});
