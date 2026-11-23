// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// In-memory backing for the config file so tests never touch the real
// ~/.config/scope/config.json. `existsSync` reports the config dir as present
// and the config file as present only once written.
let store: Record<string, string> = {};

vi.mock("node:fs", () => ({
  existsSync: (p: unknown) => {
    const path = String(p);
    if (path.endsWith("config.json")) return path in store;
    return true;
  },
  readFileSync: (p: unknown) => {
    const path = String(p);
    if (path in store) return store[path];
    throw new Error(`ENOENT: ${path}`);
  },
  writeFileSync: (p: unknown, data: unknown) => {
    store[String(p)] = String(data);
  },
  mkdirSync: () => undefined,
}));

import {
  getSelectedProjectId,
  resolveProjectId,
  requireProjectId,
  setSelectedProjectId,
} from "./config.js";

describe("cli config — project selection", () => {
  beforeEach(() => {
    store = {};
    delete process.env.SCOPE_PROJECT;
  });
  afterEach(() => {
    delete process.env.SCOPE_PROJECT;
  });

  it("resolves to undefined when nothing is set (no default project)", () => {
    expect(resolveProjectId()).toBeUndefined();
    expect(getSelectedProjectId()).toBeUndefined();
  });

  it("persists and reads back the selected project id", () => {
    setSelectedProjectId("proj-42");
    expect(getSelectedProjectId()).toBe("proj-42");
    expect(resolveProjectId()).toBe("proj-42");
  });

  it("clears the selection when set to undefined/blank", () => {
    setSelectedProjectId("proj-42");
    setSelectedProjectId(undefined);
    expect(getSelectedProjectId()).toBeUndefined();
    setSelectedProjectId("proj-42");
    setSelectedProjectId("   ");
    expect(getSelectedProjectId()).toBeUndefined();
  });

  it("follows precedence: --project flag > SCOPE_PROJECT > persisted config", () => {
    setSelectedProjectId("from-file");
    expect(resolveProjectId()).toBe("from-file");

    process.env.SCOPE_PROJECT = "from-env";
    expect(resolveProjectId()).toBe("from-env");

    expect(resolveProjectId("from-flag")).toBe("from-flag");
  });

  it("ignores blank flag/env values and falls through", () => {
    setSelectedProjectId("from-file");
    expect(resolveProjectId("   ")).toBe("from-file");
    process.env.SCOPE_PROJECT = "  ";
    expect(resolveProjectId()).toBe("from-file");
  });

  it("trims whitespace around resolved values", () => {
    process.env.SCOPE_PROJECT = "  padded  ";
    expect(resolveProjectId()).toBe("padded");
    expect(resolveProjectId("  flagged ")).toBe("flagged");
  });

  it("requireProjectId returns the id when one resolves", () => {
    setSelectedProjectId("proj-42");
    expect(requireProjectId()).toBe("proj-42");
    expect(requireProjectId("override")).toBe("override");
  });

  it("requireProjectId throws an actionable error when unset", () => {
    expect(() => requireProjectId()).toThrowError(/No project selected/);
    expect(() => requireProjectId()).toThrowError(/project use <id>/);
  });
});

describe("cli config — location", () => {
  const original = process.env.XDG_CONFIG_HOME;
  beforeEach(() => {
    store = {};
    delete process.env.SCOPE_PROJECT;
    process.env.XDG_CONFIG_HOME = "/xdg";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
  });

  it.skipIf(process.platform === "win32")("writes config.json under XDG_CONFIG_HOME", () => {
    setSelectedProjectId("proj-xdg");
    expect(Object.keys(store)).toEqual([join("/xdg", "scope", "config.json")]);
  });

  it.skipIf(process.platform === "win32")("falls back to the legacy ~/.config/scope/config.json until rewritten", () => {
    const legacy = join(homedir(), ".config", "scope", "config.json");
    store[legacy] = JSON.stringify({ selectedProjectId: "legacy-proj" });
    expect(getSelectedProjectId()).toBe("legacy-proj");

    setSelectedProjectId("new-proj");
    expect(store[join("/xdg", "scope", "config.json")]).toContain("new-proj");
    expect(store[legacy]).toContain("legacy-proj");
    expect(getSelectedProjectId()).toBe("new-proj");
  });
});
