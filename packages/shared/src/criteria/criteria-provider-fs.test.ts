// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemCriteriaProvider } from "./criteria-provider-fs.js";

describe("FileSystemCriteriaProvider", () => {
  let dir: string;

  /** Write a criteria YAML file into the temp directory. */
  const writeCriteria = (file: string, yaml: string) => writeFileSync(join(dir, file), yaml);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "criteria-fs-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is empty when the directory does not exist", async () => {
    const provider = new FileSystemCriteriaProvider(join(dir, "missing"));

    expect(await provider.size()).toBe(0);
    expect(await provider.getAll()).toEqual([]);
  });

  it("loads .yaml and .yml files and ignores other extensions", async () => {
    writeCriteria("a.yaml", "id: a\nprompt: First\n");
    writeCriteria("b.yml", "id: b\nprompt: Second\n");
    writeCriteria("notes.txt", "id: c\nprompt: Ignored\n");

    const provider = new FileSystemCriteriaProvider(dir);

    expect(await provider.size()).toBe(2);
    expect(await provider.has("a")).toBe(true);
    expect(await provider.has("b")).toBe(true);
    expect(await provider.has("c")).toBe(false);
  });

  it("trims fields and normalizes snake_case and camelCase dependencies", async () => {
    writeCriteria("root.yaml", "id: ' root '\nprompt: '  Root check  '\n");
    writeCriteria("snake.yaml", "id: snake\nprompt: Snake\ndepends_on: [' root ']\n");
    writeCriteria("camel.yaml", "id: camel\nprompt: Camel\ndependsOn: [root]\ngates: [' select ']\n");

    const provider = new FileSystemCriteriaProvider(dir);

    expect(await provider.get("root")).toEqual({ id: "root", prompt: "Root check", dependsOn: [] });
    expect((await provider.get("snake"))?.dependsOn).toEqual(["root"]);
    expect(await provider.get("camel")).toEqual({
      id: "camel",
      prompt: "Camel",
      dependsOn: ["root"],
      gates: ["select"],
    });
  });

  it.each([
    ["missing id", "prompt: Hi\n", "Missing or invalid 'id' field"],
    ["missing prompt", "id: x\n", "Missing or invalid 'prompt' field"],
    ["non-array dependencies", "id: x\nprompt: Hi\ndepends_on: root\n", "must be an array"],
    ["non-array gates", "id: x\nprompt: Hi\ngates: select\n", "'gates' must be an array"],
    ["non-object YAML", "just a string\n", "Invalid YAML content"],
  ])("rejects a file with %s", (_label, yaml, message) => {
    writeCriteria("bad.yaml", yaml);

    expect(() => new FileSystemCriteriaProvider(dir)).toThrow(
      new RegExp(`Failed to load criteria from bad\\.yaml: .*${message}`),
    );
  });

  it("rejects duplicate ids across files", () => {
    writeCriteria("one.yaml", "id: dup\nprompt: One\n");
    writeCriteria("two.yaml", "id: dup\nprompt: Two\n");

    expect(() => new FileSystemCriteriaProvider(dir)).toThrow("Duplicate criteria id 'dup'");
  });

  describe("resolveWithAncestors", () => {
    beforeEach(() => {
      writeCriteria("root.yaml", "id: root\nprompt: Root\n");
      writeCriteria("left.yaml", "id: left\nprompt: Left\ndepends_on: [root]\n");
      writeCriteria("right.yaml", "id: right\nprompt: Right\ndepends_on: [root]\n");
      writeCriteria("leaf.yaml", "id: leaf\nprompt: Leaf\ndepends_on: [left, right]\n");
    });

    it("includes transitive ancestors once each (diamond)", async () => {
      const provider = new FileSystemCriteriaProvider(dir);

      const ids = (await provider.resolveWithAncestors(["leaf"])).map((c) => c.id);

      expect(ids).toHaveLength(4);
      expect(new Set(ids)).toEqual(new Set(["leaf", "left", "right", "root"]));
    });

    it("deduplicates requested ids that are also ancestors", async () => {
      const provider = new FileSystemCriteriaProvider(dir);

      const ids = (await provider.resolveWithAncestors(["root", "left", "root"])).map((c) => c.id);

      expect(ids).toEqual(["root", "left"]);
    });

    it("names the missing id and lists the available ones", async () => {
      const provider = new FileSystemCriteriaProvider(dir);

      await expect(provider.resolveWithAncestors(["nope"])).rejects.toThrow(
        /Criteria 'nope' not found in registry\. Available criteria: .*root/,
      );
    });

    it("reports 'none' when the registry is empty", async () => {
      const provider = new FileSystemCriteriaProvider(join(dir, "missing"));

      await expect(provider.resolveWithAncestors(["x"])).rejects.toThrow("Available criteria: none");
    });
  });
});
