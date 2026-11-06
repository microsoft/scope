// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveScenarioAndPersona } from "./config-loader.js";

const dir = mkdtempSync(join(tmpdir(), "scope-config-loader-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

const validScenario = write(
  "scenario.yaml",
  'task: "summarize the file"\ncriteria:\n  - correctness\n'
);

describe("resolveScenarioAndPersona config validation", () => {
  it("reports a clear error for an empty scenario file (not a TypeError)", () => {
    const scenario = write("empty-scenario.yaml", "");
    expect(() => resolveScenarioAndPersona(scenario)).toThrowError(
      /must have a "task" string field/
    );
  });

  it("reports a clear error for a comment-only scenario file", () => {
    const scenario = write("comment-scenario.yaml", "# nothing here\n");
    expect(() => resolveScenarioAndPersona(scenario)).toThrowError(
      /must have a "task" string field/
    );
  });

  it("reports a clear error for a comment-only persona file (not a TypeError)", () => {
    const persona = write("comment-persona.yaml", "# just a comment\n");
    expect(() => resolveScenarioAndPersona(validScenario, persona)).toThrowError(
      /is empty or not a YAML mapping/
    );
  });

  it("still loads a valid scenario without a persona", () => {
    const result = resolveScenarioAndPersona(validScenario);
    expect(result.task).toBe("summarize the file");
    expect(result.criteria).toEqual(["correctness"]);
  });
});
