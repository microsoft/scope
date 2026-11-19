// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kubePodUp } from "./shared.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));

/** A kubectl result without launching a cluster or touching user credentials. */
function result(status: number) {
  return { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status, signal: null };
}

describe("kubePodUp", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset().mockReturnValue(result(0));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["cosmos-dump", "cosmos-restore"] as const)("deletes a %s pod when readiness times out", (prefix) => {
    vi.mocked(spawnSync).mockReturnValueOnce(result(0)).mockReturnValueOnce(result(1));

    expect(() => kubePodUp({ prefix, namespace: "backup", kubeContext: "test-cluster" }))
      .toThrow("in-cluster pod did not become ready");

    const runArgs = vi.mocked(spawnSync).mock.calls[0][1] as string[];
    const pod = runArgs[3];
    expect(pod).toMatch(new RegExp(`^${prefix}-`));
    expect(spawnSync).toHaveBeenLastCalledWith("kubectl", [
      "--context", "test-cluster", "delete", "pod", pod, "-n", "backup", "--wait=false",
    ], { stdio: "ignore" });
  });

  it("leaves a ready pod to the caller for use and eventual cleanup", () => {
    const pod = kubePodUp({ prefix: "cosmos-dump", namespace: "backup", kubeContext: "" });

    expect(pod).toMatch(/^cosmos-dump-/);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it("does not delete a pod when creation itself failed", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(result(1));

    expect(() => kubePodUp({ prefix: "cosmos-dump", namespace: "backup", kubeContext: "" }))
      .toThrow("failed to start in-cluster pod");
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});
