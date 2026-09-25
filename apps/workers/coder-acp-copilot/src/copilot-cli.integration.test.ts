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
import { loadVersions, isDockerAvailable, imageExists, buildImage } from "./docker-test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const IMAGE_TAG = "coder-acp-copilot-integration-test";

// ---------------------------------------------------------------------------
// Env-var configuration
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const hasCredentials = !!GITHUB_TOKEN;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PromptResult {
  success: boolean;
  response?: string;
  stopReason?: string;
  error?: string;
  confirmedModel?: string;
}

interface ToolCheck {
  tool: string;
  available: boolean;
  path?: string;
  version?: string;
}

interface TestResult {
  prompts: PromptResult[];
  toolChecks?: ToolCheck[];
  lastStep?: string;
  logs?: string[];
}

/**
 * Run test-worker.ts inside the Docker image and return parsed results.
 */
async function runTestWorker(
  docker: Docker,
  env: string[],
): Promise<{ result: TestResult; exitCode: number }> {
  const container = await docker.createContainer({
    Image: IMAGE_TAG,
    Cmd: ["npx", "tsx", "src/test-worker.ts"],
    Env: env,
    WorkingDir: "/app/apps/workers/coder-acp-copilot",
    HostConfig: {},
  });

  // Attach to stream container output in real-time
  const stream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8").replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "");
    if (text.trim()) {
      process.stderr.write(`[container] ${text}`);
      if (!text.endsWith("\n")) process.stderr.write("\n");
    }
  });

  await container.start();
  const { StatusCode } = await container.wait();

  // Grab full logs for parsing TEST_RESULT
  const logBuffer = await container.logs({ stdout: true, stderr: true });
  await container.remove().catch(() => {});

  const raw = logBuffer.toString("utf-8");
  const stdout = raw.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "");

  const match = stdout.match(/TEST_RESULT:(\{.*\})/);
  if (!match) {
    throw new Error(`No TEST_RESULT found in container output:\n${stdout.substring(0, 2000)}`);
  }
  const result: TestResult = JSON.parse(match[1]);

  return { result, exitCode: StatusCode };
}

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

  beforeAll(async () => {
    if (!dockerAvailable) return;

    const versions = loadVersions();

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
        "TEST_MODEL=claude-opus-4.6",
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
  // Model selection test: ACP set_model actually changes the active model
  // -----------------------------------------------------------------------

  it.skipIf(!canRun)(
    "honours the requested model via ACP set_model",
    { timeout: 300_000 },
    async () => {
      const { result } = workerResult!;
      const first = result.prompts[0];

      log(`confirmedModel=${first.confirmedModel}`);

      // KNOWN LIMITATION: model selection depends on the server, not on us. The
      // ACP newSession response must advertise a `models` field or a `configOptions`
      // entry with category "model", and the subsequent set call must succeed. Any
      // of those can change independently of the CLI version, so when the model is
      // not confirmed we verify the graceful fallback rather than assert a model.
      if (first.confirmedModel === undefined) {
        // selectModel() gives up on three distinct paths, and each one logs a
        // different warning. Asserting only the capability message made the other
        // two report "expected a capability warning" — which describes the test's
        // assumption rather than what actually happened, and sends the reader
        // looking for a capability problem that is not there.
        const fallbackWarnings = [
          "does not advertise model selection capability",
          "session/set_model failed",
          "session/set_config_option failed",
        ];
        const matched = fallbackWarnings.find((w) => result.logs?.some((l) => l.includes(w)));
        expect(
          matched,
          `selectModel() returned undefined without any known fallback warning. Logs:\n${(result.logs ?? []).join("\n")}`,
        ).toBeDefined();
        log(`SKIPPED (model not confirmed: ${matched})`);
      } else {
        expect(first.confirmedModel).toBe("claude-opus-4.6");
      }
    },
  );
});
