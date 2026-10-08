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
 *   TEST_SELECT_NON_DEFAULT_MODEL — select an advertised non-default model
 *     when TEST_MODEL is not set
 */
import { runTestHarness } from "test-utils/harness";
import {
  runACPSession,
  selectFirstAvailableNonDefaultModel,
} from "./acp-client.js";

const selectNonDefaultModel =
  process.env.TEST_SELECT_NON_DEFAULT_MODEL === "true";

await runTestHarness({
  runSession: (prompt, options) =>
    runACPSession(prompt, {
      ...options,
      model:
        options.model ??
        (selectNonDefaultModel
          ? selectFirstAvailableNonDefaultModel
          : undefined),
    }),
  command: "copilot",
  args: ["--acp", "--yolo"],
  getCredentialEnv: () => {
    const githubToken = process.env.GITHUB_TOKEN;
    return githubToken ? { GITHUB_TOKEN: githubToken } : undefined;
  },
  tools: ["pwsh", "python3", "git", "uv", "node", "go", "dotnet", "rustc", "cargo", "java", "mvn", "gradle"],
});
