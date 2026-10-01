// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Docker helpers shared by the ACP worker integration tests.
 */
import { readFileSync } from "fs";
import Docker from "dockerode";
import dotenv from "dotenv";

/** Parse a worker's versions.env file into Docker build args. */
export function loadVersions(versionsEnvPath: string): Record<string, string> {
  return dotenv.parse(readFileSync(versionsEnvPath));
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    const docker = new Docker();
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

export interface BuildImageOptions {
  context: string;
  tag: string;
  dockerfile: string;
  buildargs: Record<string, string>;
  target?: string;
  /** Stream build output to stderr while building. Defaults to false. */
  streamOutput?: boolean;
}

/**
 * Build a Docker image, checking for build-level errors that dockerode
 * otherwise swallows silently.
 */
export async function buildImage(docker: Docker, opts: BuildImageOptions): Promise<void> {
  const buildStream = await docker.buildImage(
    { context: opts.context, src: ["."] },
    {
      t: opts.tag,
      dockerfile: opts.dockerfile,
      buildargs: opts.buildargs,
      ...(opts.target && { target: opts.target }),
    },
  );

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err: Error | null, output: Array<{ error?: string }>) => {
        if (err) return reject(err);
        const buildError = output?.find((o) => o.error);
        if (buildError) {
          return reject(new Error(`Docker build failed: ${buildError.error}`));
        }
        resolve();
      },
      (event: { stream?: string; error?: string }) => {
        if (!opts.streamOutput) return;
        if (event.stream) process.stderr.write(event.stream);
        if (event.error) process.stderr.write(`ERROR: ${event.error}\n`);
      },
    );
  });
}
