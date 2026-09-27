#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { runACPSession } from "./acp-client.js";
import { runACPTestHarness, type ACPTestSessionOptions } from "shared/testing";

const apiKey = process.env.ANTHROPIC_API_KEY;
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const credentials: Record<string, string> = oauthToken
  ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken }
  : apiKey
    ? { ANTHROPIC_API_KEY: apiKey }
    : {};

runACPTestHarness({
  command: "claude-agent-acp",
  credentials,
  tools: ["pwsh", "python3", "git", "uv", "go", "dotnet", "rustc", "cargo", "java", "mvn", "gradle"],
  runSession: (prompt, options: ACPTestSessionOptions) => runACPSession(prompt, options),
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log("TEST_RESULT:" + JSON.stringify({ prompts: [{ success: false, error: message }] }));
  process.exit(1);
});
