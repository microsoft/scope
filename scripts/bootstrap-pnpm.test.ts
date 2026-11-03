// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/bootstrap-pnpm.sh");
const temporaryDirectories: string[] = [];
const { parse } = createRequire(resolve("packages/shared/package.json"))(
  "yaml",
) as typeof import("yaml");
const nodeDockerfiles = [
  "apps/api/Dockerfile",
  "apps/judge/Dockerfile",
  "apps/model-scanners/anthropic/Dockerfile",
  "apps/model-scanners/copilot/Dockerfile",
  "apps/portal/Dockerfile",
  "apps/scheduler/Dockerfile",
  "apps/token-manager/Dockerfile",
  "apps/workers/coder-acp-claude-code/Dockerfile",
  "apps/workers/coder-acp-copilot/Dockerfile",
  "apps/workers/post-processor/Dockerfile",
  "apps/workers/report-generator/Dockerfile",
  "packages/db-migrations/Dockerfile",
];

interface BootstrapFixture {
  callsFile: string;
  env: NodeJS.ProcessEnv;
}

interface PnpmWorkspaceConfig {
  ignoredBuiltDependencies?: string[];
  onlyBuiltDependencies?: string[];
  ignoreDepScripts?: boolean;
}

/**
 * Creates fake Corepack and npm executables that capture registry configuration.
 */
function createFixture(corepackPrepareExitCode = 0): BootstrapFixture {
  const directory = mkdtempSync(join(tmpdir(), "scope-bootstrap-pnpm-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const callsFile = join(directory, "calls");
  mkdirSync(bin);
  writeFileSync(callsFile, "");

  const corepack = join(bin, "corepack");
  writeFileSync(
    corepack,
    `#!/bin/sh
set -eu
printf 'corepack|%s|%s|%s\\n' "$*" "\${NPM_CONFIG_REGISTRY:-}" "\${COREPACK_NPM_REGISTRY:-}" >> "$BOOTSTRAP_CALLS_FILE"
if [ "\${1:-}" = "prepare" ]; then
  exit "$COREPACK_PREPARE_EXIT_CODE"
fi
`,
  );
  chmodSync(corepack, 0o755);

  const npm = join(bin, "npm");
  writeFileSync(
    npm,
    `#!/bin/sh
set -eu
printf 'npm|%s|%s|%s\\n' "$*" "\${NPM_CONFIG_REGISTRY:-}" "\${COREPACK_NPM_REGISTRY:-}" >> "$BOOTSTRAP_CALLS_FILE"
`,
  );
  chmodSync(npm, 0o755);

  return {
    callsFile,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BOOTSTRAP_CALLS_FILE: callsFile,
      COREPACK_PREPARE_EXIT_CODE: String(corepackPrepareExitCode),
    },
  };
}

/**
 * Runs the bootstrap script with deterministic fake package-manager commands.
 */
function runBootstrap(
  fixture: BootstrapFixture,
  registryEnvironment: NodeJS.ProcessEnv = {},
) {
  return spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      ...fixture.env,
      NPM_CONFIG_REGISTRY: "",
      COREPACK_NPM_REGISTRY: "",
      ...registryEnvironment,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pnpm Docker bootstrap", () => {
  it("uses public npm defaults without forcing a Corepack registry", () => {
    const fixture = createFixture();

    const result = runBootstrap(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.callsFile, "utf8")).toContain(
      "corepack|prepare pnpm@10.29.1 --activate|https://registry.npmjs.org|",
    );
  });

  it("keeps an ordinary package proxy out of Corepack metadata resolution", () => {
    const fixture = createFixture();

    const result = runBootstrap(fixture, {
      NPM_CONFIG_REGISTRY: "https://packages.example.test/npm",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.callsFile, "utf8")).toContain(
      "corepack|prepare pnpm@10.29.1 --activate|https://packages.example.test/npm|",
    );
  });

  it("normalizes trailing slashes for both registry roles", () => {
    const fixture = createFixture();

    const result = runBootstrap(fixture, {
      NPM_CONFIG_REGISTRY: "https://packages.example.test/npm///",
      COREPACK_NPM_REGISTRY: "https://corepack.example.test/metadata//",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.callsFile, "utf8")).toContain(
      "corepack|prepare pnpm@10.29.1 --activate|https://packages.example.test/npm|https://corepack.example.test/metadata",
    );
  });

  it("uses an explicit Corepack-compatible metadata registry", () => {
    const fixture = createFixture();

    const result = runBootstrap(fixture, {
      COREPACK_NPM_REGISTRY: "https://corepack.example.test",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.callsFile, "utf8")).toContain(
      "corepack|prepare pnpm@10.29.1 --activate|https://registry.npmjs.org|https://corepack.example.test",
    );
  });

  it("keeps the npm fallback independent from the Corepack override", () => {
    const fixture = createFixture(1);

    const result = runBootstrap(fixture, {
      NPM_CONFIG_REGISTRY: "https://packages.example.test/npm/",
      COREPACK_NPM_REGISTRY: "https://broken-corepack.example.test/",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(fixture.callsFile, "utf8")).toContain(
      "npm|install --global pnpm@10.29.1 --force|https://packages.example.test/npm|",
    );
  });

  it("rejects secret-bearing URLs without printing their contents", () => {
    const npmFixture = createFixture();
    const secretNpmRegistry =
      "https://build-user:super-secret@packages.example.test/private/token-123/";

    const npmResult = runBootstrap(npmFixture, {
      NPM_CONFIG_REGISTRY: secretNpmRegistry,
    });

    expect(npmResult.status).toBe(1);
    const npmDiagnostics = `${npmResult.stdout}\n${npmResult.stderr}`;
    expect(npmDiagnostics).toContain("credential-free HTTP(S) URL");
    expect(npmDiagnostics).not.toContain("build-user");
    expect(npmDiagnostics).not.toContain("super-secret");
    expect(npmDiagnostics).not.toContain("token-123");

    const corepackFixture = createFixture();
    const corepackResult = runBootstrap(corepackFixture, {
      COREPACK_NPM_REGISTRY:
        "https://corepack-user:corepack-secret@corepack.example.test/private/",
    });

    expect(corepackResult.status).toBe(1);
    const diagnostics = `${corepackResult.stdout}\n${corepackResult.stderr}`;
    expect(diagnostics).toContain("credential-free HTTP(S) URL");
    expect(diagnostics).not.toContain("corepack-user");
    expect(diagnostics).not.toContain("corepack-secret");
  });

  it("uses the shared bootstrap contract in every Node image", () => {
    for (const dockerfile of nodeDockerfiles) {
      const contents = readFileSync(dockerfile, "utf8");
      const packageInstallLines = contents
        .split("\n")
        .filter((line) => /RUN .*p?npm install/.test(line));

      expect(contents, dockerfile).toContain(
        "COPY scripts/bootstrap-pnpm.sh /usr/local/bin/bootstrap-pnpm",
      );
      expect(contents, dockerfile).toContain("ARG COREPACK_NPM_REGISTRY=");
      expect(contents, dockerfile).not.toContain(
        "COREPACK_NPM_REGISTRY=${NPM_CONFIG_REGISTRY}",
      );
      expect(contents, dockerfile).not.toMatch(
        /^ENV .*COREPACK_NPM_REGISTRY/m,
      );
      expect(contents, dockerfile).not.toMatch(/^ENV .*npm_config_registry/m);
      expect(contents, dockerfile).not.toMatch(
        /fetch[-_]retr(?:y|ies)|network-concurrency/i,
      );
      expect(contents, dockerfile).not.toContain("--ignore-scripts");
      expect(packageInstallLines.length, dockerfile).toBeGreaterThan(0);
      for (const line of packageInstallLines) {
        expect(line, dockerfile).toContain(
          'NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY}"',
        );
      }
    }
  });

  it("uses ssh2's supported JavaScript fallback without suppressing other build scripts", () => {
    const workspaceSource = readFileSync("pnpm-workspace.yaml", "utf8");
    const workspace = parse(workspaceSource) as PnpmWorkspaceConfig;

    expect(workspace.ignoredBuiltDependencies).toEqual(
      expect.arrayContaining(["cpu-features", "ssh2"]),
    );
    expect(workspace.onlyBuiltDependencies).not.toEqual(
      expect.arrayContaining(["cpu-features", "ssh2"]),
    );
    expect(workspace.onlyBuiltDependencies).toEqual(
      expect.arrayContaining(["esbuild", "keytar", "protobufjs"]),
    );
    expect(workspace.ignoreDepScripts).not.toBe(true);
    expect(readFileSync(".npmrc", "utf8")).not.toMatch(
      /^\s*ignore-scripts\s*=\s*true\s*$/m,
    );
  });
});
