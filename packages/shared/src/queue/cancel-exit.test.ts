// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelExit } from "./cancel-exit.js";

vi.mock("node:fs", () => ({ writeFileSync: vi.fn() }));

describe("worker cancellation exit", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process exited");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the existing container sentinel and exit status", () => {
    vi.stubEnv("SCOPE_HOST_WORKSPACE_ROOT", "");
    expect(() => cancelExit()).toThrow("process exited");
    expect(writeFileSync).toHaveBeenCalledWith("/tmp/.scope-cancel-exit", expect.any(String));
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits host workers without writing a shared container sentinel", () => {
    vi.stubEnv("SCOPE_HOST_WORKSPACE_ROOT", "/scope-data/workspaces/copilot");
    expect(() => cancelExit()).toThrow("process exited");
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
