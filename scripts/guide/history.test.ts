// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_FILE, readLastRecipeId, writeLastRecipeId } from "./history.js";

describe("history", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scope-guide-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("has no last recipe before anything ran", () => {
    expect(readLastRecipeId(root)).toBeUndefined();
  });

  it("remembers the most recent recipe under the gitignored .dev-state directory", () => {
    writeLastRecipeId(root, "test-unit", new Date("2026-01-02T03:04:05Z"));
    writeLastRecipeId(root, "compose-copilot");

    expect(readLastRecipeId(root)).toBe("compose-copilot");
    expect(HISTORY_FILE.startsWith(".dev-state/")).toBe(true);
  });

  it("ignores corrupt history", () => {
    const path = join(root, HISTORY_FILE);
    mkdirSync(dirname(path), { recursive: true });

    writeFileSync(path, "{not json");
    expect(readLastRecipeId(root)).toBeUndefined();

    writeFileSync(path, JSON.stringify({ recipeId: 42 }));
    expect(readLastRecipeId(root)).toBeUndefined();
  });
});
