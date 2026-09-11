// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { claudeCodeRuntime, detectClaudeCode, WORKER_TYPE } from "./runtime.js";

async function main(): Promise<void> {
  const detected = detectClaudeCode();
  if (process.argv.includes("--discover")) {
    const { discoverClaudeCode } = await import("./discovery.js");
    console.log(JSON.stringify(await discoverClaudeCode(detected)));
    return;
  }
  if (process.argv.includes("--detect")) {
    console.log(JSON.stringify(detected));
    return;
  }
  const runtime = claudeCodeRuntime(detected);
  // HAR capture must not replace the host login with Token Manager credentials.
  process.env.GATEWAY_TOKEN_PLUGIN_ENABLED = "false";
  const { startClaudeCodeWorker } = await import("coder-acp-claude-code/worker");
  await startClaudeCodeWorker(runtime);
}

main().catch((error: unknown) => {
  console.error(`${WORKER_TYPE} failed:`, error instanceof Error ? error.message : String(error));
  process.exit(1);
});
