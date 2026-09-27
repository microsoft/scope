#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { runACPSession } from "./acp-client.js";
import { runACPTestHarness, type ACPTestSessionOptions } from "shared/testing";

const githubToken = process.env.GITHUB_TOKEN;

runACPTestHarness({
  command: "copilot",
  args: ["--acp", "--yolo"],
  credentials: githubToken ? { GITHUB_TOKEN: githubToken } : {},
  tools: ["pwsh", "python3", "git", "uv", "node", "go", "dotnet", "rustc", "cargo", "java", "mvn", "gradle"],
  model: process.env.TEST_MODEL,
  runSession: (prompt, options: ACPTestSessionOptions) => runACPSession(prompt, options),
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log("TEST_RESULT:" + JSON.stringify({ prompts: [{ success: false, error: message }] }));
  process.exit(1);
});
