// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RUN_SCRATCH_ROOT,
  cleanupRunScratch,
  cleanupWorkspaces,
  createFreshWorkspace,
  getRunScratchDir,
} from "./workspace.js";

const WORKSPACES_ROOT = "/tmp/workspaces";

describe("workspace utilities", () => {
  afterEach(() => {
    if (existsSync(WORKSPACES_ROOT)) {
      rmSync(WORKSPACES_ROOT, { recursive: true, force: true });
    }
    rmSync(RUN_SCRATCH_ROOT, { recursive: true, force: true });
  });

  describe("createFreshWorkspace", () => {
    it("creates a workspace directory under /tmp/workspaces", () => {
      const result = createFreshWorkspace();
      expect(result).toMatch(/^\/tmp\/workspaces\/project-[0-9a-f]{8}$/);
      expect(existsSync(result)).toBe(true);
    });

    it("cleans previous workspace contents", () => {
      const first = createFreshWorkspace();
      expect(existsSync(first)).toBe(true);

      const second = createFreshWorkspace();
      expect(existsSync(second)).toBe(true);
      expect(existsSync(first)).toBe(false);
    });
  });

  describe("cleanupWorkspaces", () => {
    it("removes the workspaces root directory", () => {
      createFreshWorkspace();
      expect(existsSync(WORKSPACES_ROOT)).toBe(true);

      cleanupWorkspaces();
      expect(existsSync(WORKSPACES_ROOT)).toBe(false);
    });

    it("does not throw when directory does not exist", () => {
      expect(() => cleanupWorkspaces()).not.toThrow();
    });
  });

  describe("run scratch directory", () => {
    it("lives under the OS temp directory and is created on demand", () => {
      expect(RUN_SCRATCH_ROOT).toBe(join(tmpdir(), "scope-run-scratch"));
      expect(existsSync(RUN_SCRATCH_ROOT)).toBe(false);

      expect(getRunScratchDir()).toBe(RUN_SCRATCH_ROOT);
      expect(existsSync(RUN_SCRATCH_ROOT)).toBe(true);
    });

    it("is cleared when a fresh workspace is created", () => {
      const leftover = join(getRunScratchDir(), "gateway-old.har");
      writeFileSync(leftover, "{}");

      createFreshWorkspace();
      expect(existsSync(leftover)).toBe(false);
    });

    it("is removed by cleanupWorkspaces at teardown", () => {
      writeFileSync(join(getRunScratchDir(), "gateway-iter1.har"), "{}");

      cleanupWorkspaces();
      expect(existsSync(RUN_SCRATCH_ROOT)).toBe(false);
    });

    it("cleanupRunScratch does not throw when the directory does not exist", () => {
      expect(() => cleanupRunScratch()).not.toThrow();
    });
  });
});
