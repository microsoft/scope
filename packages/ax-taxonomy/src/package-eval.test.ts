// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

/** Returns a child environment with every supported credential removed. */
function credentialFreeEnvironment() {
  return {
    ...process.env,
    COPILOT_GITHUB_TOKEN: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  };
}

/** Spawns the public package command while retaining live stream ordering. */
function runPackageEval(arguments_: string[]) {
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    progressBeforeClose: boolean;
  }>((resolve, reject) => {
    const child = spawn("pnpm", ["eval", "--", ...arguments_], {
      cwd: packageDirectory,
      env: credentialFreeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let progressBeforeClose = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (String(chunk).includes("START Code/Deterministic")) {
        progressBeforeClose = true;
      }
    });
    child.once("error", reject);
    child.once("close", code => {
      resolve({ code, stdout, stderr, progressBeforeClose });
    });
  });
}

describe("ax-taxonomy package eval shortcut", () => {
  it("delegates directly to the native Taxonome eval command", async () => {
    const packageJson = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };
    expect(packageJson.scripts.eval).toContain(
      "pnpm --dir ../.. --silent taxonome eval",
    );
    expect(packageJson.scripts.eval).toContain("--inputs");
    expect(packageJson.scripts.eval).toContain("--ground-truth");
    expect(packageJson.scripts.eval).not.toContain("node scripts/");
    expect(packageJson.scripts.eval).not.toContain("--element");
  });

  it("streams deterministic progress before the final human summary", async () => {
    const result = await runPackageEval([
      "--element",
      "beh-timeout",
      "--split",
      "test",
    ]);

    expect(result.code).toBe(0);
    expect(result.progressBeforeClose).toBe(true);
    expect(result.stderr).toContain(
      "START Code/Deterministic Timeout (beh-timeout); no model calls",
    );
    expect(result.stderr).toContain("timeout-inputs.jsonl");
    expect(result.stderr.indexOf("START Code/Deterministic"))
      .toBeLessThan(result.stderr.indexOf("PASS Code/Deterministic"));
    expect(result.stdout).toContain("Result:");
    expect(result.stdout).toContain(
      "Timeout (beh-timeout; Code/Deterministic)",
    );
    expect(result.stdout).toContain("Input files:");
    expect(result.stdout).toContain("Ground truth:");
    expect(result.stdout).toContain("Inputs:");
  });

  it("emits one clean JSON document for deterministic selection", async () => {
    const result = await runPackageEval([
      "--element",
      "beh-timeout",
      "--split",
      "test",
      "--concurrency",
      "2",
      "--json",
    ]);
    const output = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(output).toMatchObject({
      passed: expect.any(Number),
      total: expect.any(Number),
      rows: expect.any(Array),
      metadata: {
        concurrency: 2,
        workers: expect.any(Array),
      },
    });
    expect(output.passed).toBe(output.total);
    expect(output.rows.every((row: { split: string }) => row.split === "test"))
      .toBe(true);
    expect(output.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ input_id: "det-input-timeout" }),
    ]));
    expect(output.metadata.workers.length).toBeLessThanOrEqual(2);
    expect(result.stdout.trimStart()).toMatch(/^\{/);
    expect(result.stderr).not.toMatch(/\u001b\[/);
  });
});
