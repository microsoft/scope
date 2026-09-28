#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Test harness that runs inside the Docker container.
 *
 * Exercises runACPSession() with the real copilot CLI binary via the shared
 * harness in test-utils, which prints a TEST_RESULT JSON line for the
 * host-side vitest test to assert on.
 *
 * Usage: npx tsx src/test-worker.ts
 *
 * Env vars:
 *   GITHUB_TOKEN  — GitHub PAT for Copilot auth (required to run prompts)
 *   TEST_PROMPT / TEST_PROMPT_2 / TEST_MODEL — see test-utils/harness
 */
import { runTestHarness } from "test-utils/harness";
import { runACPSession } from "./acp-client.js";

await runTestHarness({
  runSession: runACPSession,
  command: "copilot",
  args: ["--acp", "--yolo"],
  getCredentialEnv: () => {
    const githubToken = process.env.GITHUB_TOKEN;
    return githubToken ? { GITHUB_TOKEN: githubToken } : undefined;
  },
  tools: ["pwsh", "python3", "git", "uv", "node", "go", "dotnet", "rustc", "cargo", "java", "mvn", "gradle"],
});
