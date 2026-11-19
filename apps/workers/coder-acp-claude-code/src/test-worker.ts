#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Test harness that runs inside the Docker container.
 *
 * Exercises runACPSession() with the real claude-agent-acp binary via the
 * shared harness in test-utils, which prints a TEST_RESULT JSON line for the
 * host-side vitest test to assert on.
 *
 * Usage: npx tsx src/test-worker.ts
 *
 * Env vars (one credential required to run prompts):
 *   ANTHROPIC_API_KEY       — Anthropic API key
 *   CLAUDE_CODE_OAUTH_TOKEN — Claude Code subscription OAuth token
 *   TEST_PROMPT / TEST_PROMPT_2 — see test-utils/harness
 */
import { runTestHarness } from "test-utils/harness";
import { runACPSession } from "./acp-client.js";

await runTestHarness({
  runSession: runACPSession,
  command: "claude-agent-acp",
  args: [],
  getCredentialEnv: (): Record<string, string> | undefined => {
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (oauthToken) return { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
    if (apiKey) return { ANTHROPIC_API_KEY: apiKey };
    return undefined;
  },
  tools: ["pwsh", "python3", "git", "uv", "node", "go", "dotnet", "rustc", "cargo", "java", "mvn", "gradle"],
});
