// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "fs";
import { createFreshWorkspace, cleanupWorkspaces } from "./workspace.js";

const WORKSPACES_ROOT = "/tmp/workspaces";

describe("workspace utilities", () => {
  afterEach(() => {
    if (existsSync(WORKSPACES_ROOT)) {
      rmSync(WORKSPACES_ROOT, { recursive: true, force: true });
    }
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
});
