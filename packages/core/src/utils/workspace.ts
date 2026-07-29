// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import crypto from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import path from "path";

const WORKSPACES_ROOT = "/tmp/workspaces";

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
  const suffix = crypto.randomBytes(4).toString("hex");
  const workspacePath = path.join(WORKSPACES_ROOT, `project-${suffix}`);
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

/**
 * Clean up the workspaces root directory (`/tmp/workspaces/`).
 *
 * Safe to call even if the directory doesn't exist.
 */
export function cleanupWorkspaces(): void {
  if (existsSync(WORKSPACES_ROOT)) {
    rmSync(WORKSPACES_ROOT, { recursive: true, force: true });
  }
}
