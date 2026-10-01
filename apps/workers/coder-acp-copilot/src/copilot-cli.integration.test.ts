// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration tests for coder-acp-copilot worker.
 *
 * Builds the Docker image (dev stage) and runs test-worker.ts inside the
 * container, which exercises runACPSession() end-to-end with a real
 * GitHub token and the copilot CLI binary.
 *
 * Credentials are passed as env vars:
 *   GITHUB_TOKEN — GitHub PAT with copilot scope
 *
 * Requires Docker. Skipped automatically when Docker or credentials are unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Docker from "dockerode";
import {
  loadVersions,
  isDockerAvailable,
  imageExists,
  buildImage,
  runTestWorker,
  type TestResult,
} from "test-utils";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const IMAGE_TAG = "coder-acp-copilot-integration-test";
const WORKING_DIR = "/app/apps/workers/coder-acp-copilot";

// ---------------------------------------------------------------------------
// Env-var configuration
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const hasCredentials = !!GITHUB_TOKEN;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write to stderr so Vitest never swallows it */
function log(msg: string): void {
  process.stderr.write(`[integration] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("coder-acp-copilot integration", async () => {
  const dockerAvailable = await isDockerAvailable();
  const canRun = hasCredentials && dockerAvailable;

  if (!dockerAvailable) {
    log("Skipping: Docker unavailable");
  } else if (!hasCredentials) {
    log("No GITHUB_TOKEN — will run tool checks only");
  }

  const docker = new Docker();
  let workerResult: { result: TestResult; exitCode: number } | undefined;
  let modelSelectionResult: { result: TestResult; exitCode: number } | undefined;

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
        dockerfile: "apps/workers/coder-acp-copilot/Dockerfile",
        target: "dev",
        buildargs: versions,
      });
      log("Docker build complete");
    }

    // Run the container once — all tests share this result
    const env: string[] = [];
    if (hasCredentials) {
      env.push(
        `GITHUB_TOKEN=${GITHUB_TOKEN}`,
        "TEST_PROMPT=Generate a Hello World REST API in Python using Flask.",
      );
    }
    workerResult = await runTestWorker(docker, { image: IMAGE_TAG, workingDir: WORKING_DIR, env });
    log(`exit=${workerResult.exitCode} lastStep=${workerResult.result.lastStep}`);

    // Keep the real coding prompt on the session default. Exercise model
    // switching in a separate short session so server-side model ordering
    // cannot make the coding assertion flaky.
    if (hasCredentials) {
      modelSelectionResult = await runTestWorker(docker, {
        image: IMAGE_TAG,
        workingDir: WORKING_DIR,
        env: [
          `GITHUB_TOKEN=${GITHUB_TOKEN}`,
          "TEST_PROMPT=Reply with OK.",
          "TEST_SELECT_NON_DEFAULT_MODEL=true",
        ],
      });
      log(
        `model selection exit=${modelSelectionResult.exitCode} lastStep=${modelSelectionResult.result.lastStep}`
      );
    }
  }, 900_000); // 15 min for Docker build plus two authenticated sessions

  afterAll(async () => {
    // Image kept for faster re-runs. Use `docker system prune` to clean up.
  }, 60_000);

  // -----------------------------------------------------------------------
  // Tool availability: each tool gets its own test for CI visibility
  // -----------------------------------------------------------------------

  for (const tool of ["pwsh", "python3", "git", "uv", "node", "go", "dotnet", "rustc", "cargo", "java", "mvn", "gradle"]) {
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
    "completes coding prompts with real GitHub auth",
    { timeout: 300_000 },
    async () => {
      const { result } = workerResult!;
      log(`prompts completed: ${result.prompts.length}`);

      // --- First prompt assertions ---
      const first = result.prompts[0];
      expect(first.error, `First prompt failed: ${first?.error}`).toBeUndefined();
      expect(first.success).toBe(true);
      expect(first.response).toBeTruthy();

      // The copilot CLI writes code to files via tool calls and returns a
      // human-readable summary, so we only verify the response is non-trivial.
      expect(
        first.response!.length > 10,
        `Expected non-trivial response, got: ${first.response!.substring(0, 200)}`,
      ).toBe(true);
    },
  );

  // -----------------------------------------------------------------------
  // Model selection test: ACP changes to an advertised non-default model
  // -----------------------------------------------------------------------

  it.skipIf(!canRun)(
    "selects an advertised non-default model via ACP",
    { timeout: 300_000 },
    async () => {
      const { result } = modelSelectionResult!;
      const first = result.prompts[0];

      expect(
        first.error,
        `Model selection probe failed: ${first?.error}`
      ).toBeUndefined();
      expect(first.success).toBe(true);
      log(`confirmedModel=${first.confirmedModel}`);

      if (first.confirmedModel === undefined) {
        const selectionUnavailable = result.logs?.some(
          (line) =>
            line.includes("does not advertise model selection capability") ||
            line.includes(
              "model selector did not choose a model from the advertised model options"
            )
        );
        const selectionFailed = result.logs?.some(
          (line) =>
            line.includes("session/set_model failed") ||
            line.includes("session/set_config_option failed for model")
        );

        expect(
          selectionFailed,
          "Dynamic model selection reached an ACP selection method but failed",
        ).toBe(false);
        expect(
          selectionUnavailable,
          "Expected an explicit warning when no alternate advertised model can be selected",
        ).toBe(true);
        log("SKIPPED (server did not advertise an alternate selectable model)");
      } else {
        expect(first.initialModel, "Expected the session's initial model").toBeTruthy();
        expect(first.confirmedModel).not.toBe(first.initialModel);
      }
    },
  );
});
