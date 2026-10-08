// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const installer = resolve("install-cli.sh");
const curlFixture = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith('https://'));
fs.appendFileSync(process.env.CURL_LOG, url + '\\n');
if (url === 'https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh') {
  const output = args[args.indexOf('--output') + 1];
  if (process.env.INSTALLER_ERROR) {
    fs.writeFileSync(output, 'echo damaged > "$SCOPE_INSTALL_DIR/scope"\\n');
    console.error('Installer download failed');
    process.exit(22);
  }
  fs.copyFileSync(process.env.ROOT_INSTALLER, output);
} else if (url === 'https://api.github.com/repos/microsoft/scope/releases') {
  if (process.env.RELEASE_ERROR) { console.error('Release request failed'); process.exit(22); }
  console.log(process.env.RELEASES);
} else if (url === 'https://github.com/microsoft/scope/releases/download/cli%2Fv3.2.1/scope.mjs') {
  if (process.env.DOWNLOAD_ERROR) { console.error('Asset download failed'); process.exit(22); }
  fs.writeFileSync(args[args.indexOf('--output') + 1], '#!/usr/bin/env node\\nconsole.log("' + process.env.BUNDLE_VERSION + '");\\n');
} else { console.error('Unexpected URL: ' + url); process.exit(1); }
`;

describe.each(["install-cli.sh", "website/install-cli.sh"])("Public CLI installer: %s", (entryPoint) => {
  it.each([
    { name: "success", success: true },
    { name: "missing release", releases: "[]", message: "No published Scope CLI release" },
    { name: "API error", releaseError: "1", message: "Release request failed" },
    { name: "download error", downloadError: "1", message: "Asset download failed" },
    { name: "wrong artifact version", version: "3.2.0", message: "does not match" },
  ])("handles $name without touching a real installation", ({ success, releases, releaseError, downloadError, version, message }) => {
    const directory = mkdtempSync(join(tmpdir(), "scope-install-test-"));
    const installDir = join(directory, "bin with spaces");
    const log = join(directory, "curl.log");
    mkdirSync(installDir);
    writeFileSync(join(installDir, "scope"), "existing installation");
    writeFileSync(join(directory, "curl"), curlFixture, { mode: 0o755 });
    writeFileSync(join(directory, "gh"), '#!/bin/sh\necho "Unexpected GitHub authentication dependency" >&2\nexit 1\n', { mode: 0o755 });
    try {
      const result = spawnSync("bash", [], {
        input: readFileSync(entryPoint, "utf8"),
        cwd: directory,
        env: {
          ...process.env, PATH: `${directory}:${process.env.PATH}`, SCOPE_INSTALL_DIR: installDir,
          GH_TOKEN: "", GITHUB_TOKEN: "", ROOT_INSTALLER: installer, INSTALLER_ERROR: "",
          CURL_LOG: log, RELEASE_ERROR: releaseError ?? "", DOWNLOAD_ERROR: downloadError ?? "",
          BUNDLE_VERSION: version ?? "3.2.1",
          RELEASES: releases ?? JSON.stringify([
            { tag_name: "cli/v9.0.0", draft: true },
            { tag_name: "other/v4.0.0" },
            { tag_name: "cli/v4.0.0-beta.1", prerelease: true },
            { tag_name: "cli/v3.2.1" },
          ]),
        },
        encoding: "utf8",
        timeout: 10000,
      });
      const installed = readFileSync(join(installDir, "scope"), "utf8");
      if (success) {
        expect(result.status, result.stderr).toBe(0);
        expect(installed).toContain('console.log("3.2.1")');
        expect(statSync(join(installDir, "scope")).mode & 0o777).toBe(0o755);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(message);
        expect(installed).toBe("existing installation");
      }
      expect(readdirSync(installDir)).toEqual(["scope"]);
      const requests = readFileSync(log, "utf8").trim().split("\n");
      expect(requests[0]).toBe(entryPoint.startsWith("website/")
        ? "https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh"
        : "https://api.github.com/repos/microsoft/scope/releases");
      expect(requests.join("\n")).not.toMatch(/scope-core|scope-doc/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it("does not execute a partial website installer download or replace an existing installation", () => {
  const directory = mkdtempSync(join(tmpdir(), "scope-install-bootstrap-test-"));
  const installDir = join(directory, "bin");
  const temporary = join(directory, "tmp");
  mkdirSync(installDir);
  mkdirSync(temporary);
  writeFileSync(join(installDir, "scope"), "existing installation");
  writeFileSync(join(directory, "curl"), curlFixture, { mode: 0o755 });
  try {
    const result = spawnSync("bash", [], {
      input: readFileSync("website/install-cli.sh", "utf8"),
      cwd: directory,
      env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, SCOPE_INSTALL_DIR: installDir,
        TMPDIR: temporary, CURL_LOG: join(directory, "curl.log"), INSTALLER_ERROR: "1",
        GH_TOKEN: "", GITHUB_TOKEN: "",
      },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Installer download failed");
    expect(readFileSync(join(installDir, "scope"), "utf8")).toBe("existing installation");
    expect(readdirSync(temporary)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("routes published onboarding examples to the public canonical installer", () => {
  for (const file of ["install-cli.md", "access.md"]) {
    const content = readFileSync(`website/src/content/docs/getting-started/${file}`, "utf8");
    expect(content).toContain("https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh");
    expect(content).not.toMatch(/growth-ecosystems|scope-doc|GH_TOKEN|GITHUB_TOKEN/);
  }
  expect(readFileSync("website/src/content/docs/getting-started/install-cli.md", "utf8"))
    .toContain("| SCOPE_INSTALL_DIR=~/bin bash");
  expect(readFileSync("website/src/content/docs/getting-started/access.md", "utf8"))
    .toContain("your deployment's API still requires its configured authentication");
  const compatibilityScript = readFileSync("website/install-cli.sh", "utf8");
  expect(compatibilityScript).not.toContain("api.github.com/repos");
  expect(compatibilityScript).toContain("--retry 3");
});
