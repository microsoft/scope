// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration tests for coder-acp-claude-code worker.
 *
 * Builds the Docker image (dev stage) and runs test-worker.ts inside the
 * container, which exercises runACPSession() end-to-end with a real
 * Anthropic API key and the claude-agent-acp binary.
 *
 * Credentials are passed as env vars (one of):
 *   ANTHROPIC_API_KEY      — Anthropic API key
 *   CLAUDE_CODE_OAUTH_TOKEN — Claude Code subscription OAuth token
 *
 * Requires Docker. Skipped automatically when Docker or credentials are unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Docker from "dockerode";
import {
  loadVersions, isDockerAvailable, imageExists, buildImage, runDockerTestWorker,
  type ACPIntegrationTestResult,
} from "shared/testing";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const IMAGE_TAG = "coder-acp-claude-code-integration-test";

// ---------------------------------------------------------------------------
// Env-var configuration
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const hasCredentials = !!(ANTHROPIC_API_KEY || CLAUDE_CODE_OAUTH_TOKEN);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestResult = ACPIntegrationTestResult;

async function runTestWorker(docker: Docker, env: string[]): Promise<{ result: TestResult; exitCode: number }> {
  const worker = await runDockerTestWorker<TestResult>(docker, {
    image: IMAGE_TAG,
    workingDir: "/app/apps/workers/coder-acp-claude-code",
    env,
  });
  if (!worker.result) {
    throw new Error(`No TEST_RESULT found in container output:\n${worker.output.substring(0, 2000)}`);
  }
  return { result: worker.result, exitCode: worker.exitCode };
}

/** Write to stderr so Vitest never swallows it */
function log(msg: string): void {
  process.stderr.write(`[integration] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("coder-acp-claude-code integration", async () => {
  const dockerAvailable = await isDockerAvailable();
  const canRun = hasCredentials && dockerAvailable;

  if (!dockerAvailable) {
    log("Skipping: Docker unavailable");
  } else if (!hasCredentials) {
    log("No credentials — will run tool checks only");
  }

  const docker = new Docker();
  let workerResult: { result: TestResult; exitCode: number } | undefined;

  beforeAll(async () => {
    if (!dockerAvailable) return;

    const versions = loadVersions(resolve(__dirname, "..", "versions.env"));

    if (await imageExists(docker, IMAGE_TAG)) {
      log("Docker image already exists (pre-built by CI), skipping build");
    } else {
      log("Building Docker image (dev stage)...");
      await buildImage(docker, {
        context: REPO_ROOT,
        tag: IMAGE_TAG,
        dockerfile: "apps/workers/coder-acp-claude-code/Dockerfile",
        target: "dev",
        buildargs: versions,
      });
      log("Docker build complete");
    }

    // Run the container once — both tests share this result
    const env: string[] = [];
    if (hasCredentials) {
      const credentialEnv = CLAUDE_CODE_OAUTH_TOKEN
        ? `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}`
        : `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`;
      env.push(
        credentialEnv,
        "TEST_PROMPT=Generate a Hello World REST API in Python using Flask.",
        "TEST_PROMPT_2=Add a /health endpoint to the Flask app that returns 200 OK.",
      );
    }
    workerResult = await runTestWorker(docker, env);
    log(`exit=${workerResult.exitCode} lastStep=${workerResult.result.lastStep}`);
  }, 600_000); // 10 min for Docker build

  afterAll(async () => {
    // Image kept for faster re-runs. Use `docker system prune` to clean up.
  }, 60_000);

  // -----------------------------------------------------------------------
  // Tool availability: each tool gets its own test for CI visibility
  // -----------------------------------------------------------------------

  for (const tool of ["pwsh", "python3", "git", "uv", "go", "dotnet", "rustc", "cargo", "java", "mvn", "gradle"]) {
    it.skipIf(!dockerAvailable)(
      `has ${tool} in PATH`,
      { timeout: 30_000 },
      async () => {
        const { result } = workerResult!;
        expect(result.toolChecks, "toolChecks missing from result").toBeDefined();
        const check = result.toolChecks!.find((t) => t.tool === tool);
        expect(check, `${tool} check missing`).toBeTruthy();
        expect(check!.available, `${tool} should be in PATH`).toBe(true);
      },
    );
  }

  // -----------------------------------------------------------------------
  // Coding prompt e2e: real auth + coding prompt + session reuse
  // -----------------------------------------------------------------------

  it.skipIf(!canRun)(
    "completes coding prompts with real Anthropic auth",
    { timeout: 300_000 },
    async () => {
      const { result } = workerResult!;
      log(`prompts completed: ${result.prompts.length}`);

      // --- First prompt assertions ---
      const first = result.prompts[0];
      expect(first, "First prompt result missing").toBeTruthy();
      expect(first.error, `First prompt failed: ${first?.error}`).toBeUndefined();
      expect(first.success).toBe(true);
      expect(first.response).toBeTruthy();

      // Claude Code writes code to files via tool calls and returns a
      // human-readable summary, so we only verify the response is non-trivial.
      expect(
        first.response!.length > 10,
        `Expected non-trivial response, got: ${first.response!.substring(0, 200)}`,
      ).toBe(true);

      // --- Second prompt assertions (session reuse) ---
      const second = result.prompts[1];
      expect(second, "Second prompt result missing — session reuse not tested").toBeTruthy();
      expect(second.error, `Second prompt failed: ${second?.error}`).toBeUndefined();
      expect(second.success).toBe(true);
      expect(second.response).toBeTruthy();

      expect(
        second.response!.length > 10,
        `Expected non-trivial response, got: ${second.response!.substring(0, 200)}`,
      ).toBe(true);
    },
  );
});
