// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import crypto from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import os from "os";
import path from "path";

const WORKSPACES_ROOT = "/tmp/workspaces";

/**
 * Scratch directory for a run's temporary artifacts that live outside the
 * workspace, such as gateway HAR downloads (#703). Workers handle one run at
 * a time, so a single directory per process is enough. It is wiped together
 * with the workspaces root when a run starts and when it ends, so these files
 * no longer pile up in `/tmp` across runs in a long-lived pod.
 */
export const RUN_SCRATCH_ROOT = path.join(os.tmpdir(), "scope-run-scratch");

/**
 * Create a fresh, isolated workspace directory for a worker run.
 *
 * Cleans the parent `/tmp/workspaces/` directory first so leftovers from
 * crashed runs are always removed, then creates a new `project-<rand>`
 * subdirectory.
 *
 * @returns The absolute path to the new workspace directory (e.g. `/tmp/workspaces/project-a1b2c3d4`).
 */
export function createFreshWorkspace(): string {
  if (existsSync(WORKSPACES_ROOT)) {
    rmSync(WORKSPACES_ROOT, { recursive: true, force: true });
  }
  cleanupRunScratch();
  const suffix = crypto.randomBytes(4).toString("hex");
  const workspacePath = path.join(WORKSPACES_ROOT, `project-${suffix}`);
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

/**
 * Clean up the workspaces root directory (`/tmp/workspaces/`) and the run
 * scratch directory ({@link RUN_SCRATCH_ROOT}).
 *
 * Safe to call even if the directories don't exist.
 */
export function cleanupWorkspaces(): void {
  if (existsSync(WORKSPACES_ROOT)) {
    rmSync(WORKSPACES_ROOT, { recursive: true, force: true });
  }
  cleanupRunScratch();
}

/**
 * Return the run scratch directory, creating it if needed. Put per-run
 * temporary files here (instead of bare `os.tmpdir()`) so worker teardown
 * removes them.
 *
 * @returns The absolute path of {@link RUN_SCRATCH_ROOT}.
 */
export function getRunScratchDir(): string {
  mkdirSync(RUN_SCRATCH_ROOT, { recursive: true });
  return RUN_SCRATCH_ROOT;
}

/**
 * Remove the run scratch directory and everything in it.
 *
 * Safe to call even if the directory doesn't exist.
 */
export function cleanupRunScratch(): void {
  rmSync(RUN_SCRATCH_ROOT, { recursive: true, force: true });
}
