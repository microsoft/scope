// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cliRoot = resolve(import.meta.dirname, "..");
const pkg: { version: string } = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
const artifact = join(cliRoot, "dist", `scope-cli-${pkg.version}.tgz`);
let directory: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scope-cli-package-test-"));
  cwd = join(directory, "consumer");
  mkdirSync(cwd);
  // Do not load a developer's repository .env by walking up from the consumer.
  writeFileSync(join(cwd, ".env"), "");
  env = {
    PATH: process.env.PATH,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
    HOME: join(directory, "home"),
    USERPROFILE: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    LOCALAPPDATA: join(directory, "appdata"),
    SCOPE_NO_UPDATE_CHECK: "1",
    SCOPE_TOKEN: "",
    SCOPE_PROJECT: "",
    SCOPE_API_URL: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  };
});

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function scope(...args: string[]): Promise<string> {
  const { stdout } = await execute(process.platform === "win32" ? "npx.cmd" : "npx", [
    "--offline", "--yes", "--cache", join(directory, "cache"),
    "--package", artifact, "scope", ...args,
  ], { cwd, env, timeout: 30_000, ...(process.platform === "win32" ? { shell: true } : {}) });
  return stdout;
}

it("installs the actual tarball offline and runs environment commands without runtime dependencies or personal state", async () => {
  expect((await scope("--version")).trim()).toBe(pkg.version);
  expect(await scope("--help")).toContain("--env <name>");
  expect(await scope("agent", "setup", "--help")).toContain("--consent");
  expect(await scope("secret", "create", "--help")).toContain("--api-key-stdin");
  expect(await scope("secret", "portal-ai", "set", "--help")).toContain("--key-id");
  await scope("env", "add", "local", "--url", "http://127.0.0.1:43127");
  await scope("env", "use", "local");
  await scope("env", "set", "project", "smoke-project");
  const output: unknown = JSON.parse(await scope("env", "show", "-o", "json"));
  expect(output).toEqual([{ name: "local", active: "true", url: "http://127.0.0.1:43127", project: "smoke-project", token: "N/A" }]);
  await scope("env", "use", "--clear");
  await scope("env", "remove", "local");
  expect(JSON.parse(await scope("env", "list", "-o", "json"))).toEqual([]);
});
