// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const forbidden = /\bcases?\b|\bgold\b|heldout|held-out|--cases|--gold|case_id/i;
const forbiddenSplit = /"split"\s*:\s*"unit"|validation,\s*test,\s*unit/i;
const extensions = new Set([".ts", ".mjs", ".json", ".jsonl", ".md", ".yaml"]);

/** Recursively collects active text files while excluding generated/frozen areas. */
async function activeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["dist", "node_modules", "evidence"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await activeFiles(path));
    else if (
      extensions.has(extname(entry.name)) &&
      !["evidence.test.ts", "terminology.test.ts"].includes(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

describe("active Taxonome evaluation terminology", () => {
  it("uses inputs, ground truth, and test outside frozen evidence", async () => {
    const files = [
      ...await activeFiles(join(root, "apps/taxonome")),
      ...await activeFiles(join(root, "packages/taxonomy-engine/src")),
      ...await activeFiles(join(root, "packages/ax-taxonomy")),
      join(root, "examples/taxonome-custom-handler/README.md"),
      join(root, "evaluations/static-prompts/adapter/standalone.ts"),
      join(root, "evaluations/static-prompts/adapter/standalone.test.ts"),
      join(root, "evaluations/static-prompts/evaluation-manifest.yaml"),
    ];

    for (const file of files) {
      expect(file, file).not.toMatch(forbidden);
      const content = await readFile(file, "utf8");
      expect(content, file).not.toMatch(forbidden);
      expect(content, file).not.toMatch(forbiddenSplit);
    }

    const architecture = await readFile(
      join(root, "docs/architecture/taxonome.md"),
      "utf8",
    );
    const current = architecture.split("## Recorded spike findings")[0];
    expect(current).not.toMatch(forbidden);
    expect(current).not.toMatch(forbiddenSplit);
  });
});
