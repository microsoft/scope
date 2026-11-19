// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Host-side runner: starts the in-container test harness and parses its result.
 */
import type Docker from "dockerode";
import { TEST_RESULT_MARKER, type TestResult } from "./types.js";

// Docker's multiplexed log stream embeds control bytes in each frame header.
const CONTROL_CHARS = /[\x00-\x09\x0b\x0c\x0e-\x1f]/g;

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

/** Extract the harness's TEST_RESULT JSON from raw container output. */
export function parseTestResult(output: string): TestResult {
  const clean = stripControlChars(output);
  const match = clean.match(new RegExp(`${TEST_RESULT_MARKER}(\\{.*\\})`));
  if (!match) {
    throw new Error(`No TEST_RESULT found in container output:\n${clean.substring(0, 2000)}`);
  }
  return JSON.parse(match[1]) as TestResult;
}

export interface RunTestWorkerOptions {
  /** Docker image tag to run. */
  image: string;
  /** Working directory inside the container (the worker's package dir). */
  workingDir: string;
  /** Env vars in KEY=value form. */
  env: string[];
  /** Command to run. Defaults to the worker's src/test-worker.ts harness. */
  cmd?: string[];
}

/**
 * Run the test harness inside the Docker image and return the parsed result.
 */
export async function runTestWorker(
  docker: Docker,
  opts: RunTestWorkerOptions,
): Promise<{ result: TestResult; exitCode: number }> {
  const container = await docker.createContainer({
    Image: opts.image,
    Cmd: opts.cmd ?? ["npx", "tsx", "src/test-worker.ts"],
    Env: opts.env,
    WorkingDir: opts.workingDir,
    HostConfig: {},
  });

  // Attach to stream container output in real-time
  const stream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  stream.on("data", (chunk: Buffer) => {
    const text = stripControlChars(chunk.toString("utf-8"));
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

  return { result: parseTestResult(logBuffer.toString("utf-8")), exitCode: StatusCode };
}
