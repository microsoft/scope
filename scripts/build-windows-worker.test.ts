// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/build-windows-worker.ps1");

function runBuild(failAt = "", os = "windows") {
  const directory = mkdtempSync(join(tmpdir(), "scope-windows-build-"));
  const log = join(directory, "docker.jsonl");
  try {
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", `
      function docker {
        Add-Content -Path $env:DOCKER_LOG -Value (ConvertTo-Json -InputObject @($args) -Compress)
        $global:LASTEXITCODE = 0
        if ($env:FAIL_AT -and (($args -join ' ') -like "*$env:FAIL_AT*")) {
          $global:LASTEXITCODE = 23
          return
        }
        if ($args[0] -eq 'info') { $env:DOCKER_OS }
      }
      & $env:BUILD_SCRIPT
    `], {
      env: { ...process.env, DOCKER_LOG: log, FAIL_AT: failAt, DOCKER_OS: os, BUILD_SCRIPT: script },
      encoding: "utf8",
      timeout: 10000,
    });
    if (result.error) throw result.error;
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Windows local image validation", () => {
  it("builds base, pinned dependencies and worker locally, then smoke-tests without publishing", () => {
    const result = runBuild();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.map((args) => args[0])).toEqual(["info", "build", "build", "build", "run"]);
    expect(result.calls[1]).toContain("scope-windows-base:ci");
    expect(result.calls[2]).toContain("BASE_IMAGE=scope-windows-base:ci");
    expect(result.calls[3]).toContain("DEPS_IMAGE=scope-windows-deps:ci");
    const version = readFileSync("apps/workers/coder-acp-copilot/versions.env", "utf8").match(/^COPILOT_CLI_VERSION=(.+)$/m)![1];
    expect(result.calls[2]).toContain(`COPILOT_CLI_VERSION=${version}`);
    expect(result.calls[3]).toContain(`COPILOT_CLI_VERSION=${version}`);
    expect(result.calls[4]).toContain("scope-copilot-windows:ci");
    expect(JSON.stringify(result.calls)).not.toMatch(/login|push|azurecr|scope-core/);
  });

  it.each(["info", "Dockerfile.base", "Dockerfile.deps", "Dockerfile.windows", "run"])("stops immediately on a failing docker %s", (stage) => {
    const result = runBuild(stage);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("failed with exit code 23");
    expect(result.calls.at(-1)?.join(" ")).toContain(stage);
  });

  it("rejects a Linux Docker engine rather than pretending to validate Windows", () => {
    const result = runBuild("", "linux");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires a Windows Docker engine");
    expect(result.calls).toHaveLength(1);
  });

  it("propagates native installer and compilation failures from Windows PowerShell Docker RUN steps", () => {
    for (const file of ["Dockerfile.base", "Dockerfile.deps", "Dockerfile.windows"]) {
      const source = readFileSync(`apps/workers/coder-acp-copilot-windows/${file}`, "utf8");
      for (const line of source.split("\n").filter((line) => /(?:pnpm\.exe|npm|choco) (?:install|--filter)/.test(line))) {
        expect(line, file).toContain("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }");
      }
    }
  });
});
