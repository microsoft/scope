// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "fs";
import { resolve } from "path";
import Docker from "dockerode";

export interface PromptResult {
  success: boolean;
  response?: string;
  stopReason?: string;
  error?: string;
  confirmedModel?: string;
}

export interface ToolCheck {
  tool: string;
  available: boolean;
  path?: string;
  version?: string;
}

export interface ACPIntegrationTestResult {
  prompts: PromptResult[];
  toolChecks?: ToolCheck[];
  lastStep?: string;
  logs?: string[];
}

export interface DockerWorkerResult<T = ACPIntegrationTestResult> {
  exitCode: number;
  output: string;
  result?: T;
}

export function loadVersions(versionsFile: string): Record<string, string> {
  const content = readFileSync(versionsFile, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) result[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return result;
}

export async function isDockerAvailable(docker = new Docker()): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export async function imageExists(docker: Docker, tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function buildImage(
  docker: Docker,
  options: { context: string; tag: string; dockerfile: string; target?: string; buildargs?: Record<string, string> },
): Promise<void> {
  const stream = await docker.buildImage(
    { context: options.context, src: ["."] },
    {
      t: options.tag,
      dockerfile: options.dockerfile,
      target: options.target,
      buildargs: options.buildargs,
    },
  );

  await new Promise<void>((resolvePromise, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null, output: Array<{ error?: string }>) => {
        if (err) return reject(err);
        const buildError = output?.find((event) => event.error);
        if (buildError) return reject(new Error(`Docker build failed: ${buildError.error}`));
        resolvePromise();
      },
      (event: { stream?: string; error?: string }) => {
        if (event.stream) process.stderr.write(event.stream);
        if (event.error) process.stderr.write(`ERROR: ${event.error}\n`);
      },
    );
  });
}

export async function runDockerTestWorker<T = ACPIntegrationTestResult>(
  docker: Docker,
  options: { image: string; workingDir: string; env?: string[]; command?: string[] },
): Promise<DockerWorkerResult<T>> {
  const container = await docker.createContainer({
    Image: options.image,
    Cmd: options.command ?? ["npx", "tsx", "src/test-worker.ts"],
    Env: options.env ?? [],
    WorkingDir: options.workingDir,
    HostConfig: {},
  });

  try {
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    let output = "";
    const stdout = new (await import("stream")).PassThrough();
    const stderr = new (await import("stream")).PassThrough();
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    stderr.on("data", (chunk) => { output += chunk.toString(); });
    docker.modem.demuxStream(stream, stdout, stderr);

    await container.start();
    const waitResult = await container.wait();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    const marker = "TEST_RESULT:";
    const markerIndex = output.lastIndexOf(marker);
    let result: T | undefined;
    if (markerIndex >= 0) {
      const jsonLine = output.slice(markerIndex + marker.length).split("\n")[0].trim();
      result = JSON.parse(jsonLine) as T;
    }

    return { exitCode: waitResult.StatusCode, output, result };
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

export function resolveVersionsFile(repoRoot: string, workerPath: string): string {
  return resolve(repoRoot, workerPath, "versions.env");
}
