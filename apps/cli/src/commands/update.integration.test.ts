// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bundlePath = resolve(import.meta.dirname, "../../dist/scope.mjs");
let directory: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
  if (directory) rmSync(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

/** Exercise the real installed bundle with a local release list and fake downloader. */
async function runUpdate(downloadedSource: string) {
  directory = mkdtempSync(join(tmpdir(), "scope-update-"));
  const installedPath = join(directory, "scope");
  copyFileSync(bundlePath, installedPath);
  const before = readFileSync(installedPath, "utf-8");

  // The fake gh only writes the supplied synthetic bundle to the requested path.
  const downloaderPath = join(directory, "gh");
  writeFileSync(downloaderPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "release" || args[1] !== "download") process.exit(2);
fs.writeFileSync(args[args.indexOf("-O") + 1], process.env.SCOPE_TEST_BUNDLE);
`);
  chmodSync(downloaderPath, 0o755);

  server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ tag_name: "cli/v9.0.0" }]));
  });
  await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing mock server port");

  let failed = false;
  try {
    await execFileAsync(process.execPath, ["--no-global-search-paths", installedPath, "update"], {
      cwd: directory,
      env: {
        ...process.env,
        NODE_PATH: "",
        NODE_OPTIONS: "",
        PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        SCOPE_NO_UPDATE_CHECK: "1",
        SCOPE_RELEASES_URL: `http://127.0.0.1:${address.port}`,
        SCOPE_TEST_BUNDLE: downloadedSource,
      },
      timeout: 15_000,
    });
  } catch {
    failed = true;
  }
  return { failed, before, after: readFileSync(installedPath, "utf-8"), files: readdirSync(directory) };
}

describe.skipIf(process.platform === "win32")("standalone CLI update validation", () => {
  it.each([
    ["invalid JavaScript", "this is not JavaScript"],
    ["wrong version", 'console.log("8.0.0");'],
  ])("preserves the installed CLI for %s", async (_description, downloadedSource) => {
    const result = await runUpdate(downloadedSource);
    expect(result.failed).toBe(true);
    expect(result.after).toBe(result.before);
    expect(result.files).toEqual(["gh", "scope"]);
  });

  it("installs a matching executable bundle", async () => {
    const downloadedSource = 'console.log("9.0.0");';
    const result = await runUpdate(downloadedSource);
    expect(result.failed).toBe(false);
    expect(result.after).toBe(downloadedSource);
    expect(result.files).toEqual(["gh", "scope"]);
  });
});
