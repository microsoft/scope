// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { Recipe } from "./catalog.js";
import { describeFailure, exitCodeOf, runRecipe, type StepSpawner } from "./runner.js";

describe("runRecipe", () => {
  const recipe: Recipe = {
    id: "checks",
    title: "Checks",
    summary: "",
    category: "quality",
    steps: [{ pnpm: ["lint"] }, { pnpm: ["test"] }, { pnpm: ["headers:check"] }],
  };

  /** Records each spawned command and exits with the scripted code for its script. */
  function fakeSpawner(exitCodes: Record<string, number> = {}) {
    const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const spawnStep: StepSpawner = async (args, options) => {
      calls.push({ args, ...options });
      return exitCodes[args[0]] ?? 0;
    };
    return { calls, spawnStep };
  }

  it("runs every step in order from the given directory with the given environment", async () => {
    const { calls, spawnStep } = fakeSpawner();
    const started: number[] = [];

    const result = await runRecipe(recipe, { cwd: "/repo", env: { A: "1" }, spawnStep, onStep: (_step, index) => started.push(index) });

    expect(result).toEqual({ exitCode: 0 });
    expect(calls.map((call) => call.args[0])).toEqual(["lint", "test", "headers:check"]);
    expect(calls.every((call) => call.cwd === "/repo" && call.env.A === "1")).toBe(true);
    expect(started).toEqual([0, 1, 2]);
  });

  it("stops at the first failing step and reports it", async () => {
    const { calls, spawnStep } = fakeSpawner({ test: 3 });

    const result = await runRecipe(recipe, { cwd: "/repo", env: {}, spawnStep });

    expect(calls.map((call) => call.args[0])).toEqual(["lint", "test"]);
    expect(result).toEqual({ exitCode: 3, failedStep: { pnpm: ["test"] } });
    expect(describeFailure(result)).toBe("pnpm test exited with code 3.");
  });
});

describe("exitCodeOf", () => {
  it("uses the exit code, or 128 + signal number for signals", () => {
    expect(exitCodeOf(0, null)).toBe(0);
    expect(exitCodeOf(2, null)).toBe(2);
    expect(exitCodeOf(null, "SIGINT")).toBe(130);
    expect(exitCodeOf(null, null)).toBe(1);
  });
});
