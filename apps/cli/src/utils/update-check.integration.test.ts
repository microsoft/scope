// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, afterEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const BUNDLE_PATH = resolve(import.meta.dirname, "../../dist/scope.mjs");

let apiServer: Server;
let releaseServer: Server;
let apiPort: number;
let releasePort: number;
let releaseResponse: { status: number; body: unknown };

async function startServers(): Promise<void> {
  // Mock API server (for run list)
  apiServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [], pageInfo: { hasNextPage: false } }));
  });
  await new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", () => r()));
  const apiAddr = apiServer.address();
  apiPort = typeof apiAddr === "object" && apiAddr ? apiAddr.port : 0;

  // Mock release server
  releaseServer = createServer((_req, res) => {
    res.writeHead(releaseResponse.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(releaseResponse.body));
  });
  await new Promise<void>((r) => releaseServer.listen(0, "127.0.0.1", () => r()));
  const relAddr = releaseServer.address();
  releasePort = typeof relAddr === "object" && relAddr ? relAddr.port : 0;
}

function stopServers(): void {
  apiServer?.close();
  releaseServer?.close();
}

/** Run a command against the bundle with controlled env */
async function runBundle(args: string[], tempDir: string) {
  const isolatedBundle = join(tempDir, "scope.mjs");
  copyFileSync(BUNDLE_PATH, isolatedBundle);
  return execFileAsync(process.execPath, ["--no-global-search-paths", isolatedBundle, ...args], {
    cwd: tempDir,
    env: {
      ...process.env,
      NODE_PATH: "",
      NODE_OPTIONS: "",
      SCOPE_NO_UPDATE_CHECK: "",
      SCOPE_RELEASES_URL: `http://127.0.0.1:${releasePort}`,
      SCOPE_API_URL: `http://127.0.0.1:${apiPort}`,
      SCOPE_PROJECT: "test-project",
      HOME: tempDir,
    },
    timeout: 10000,
  });
}

describe("update-check (via bundle)", () => {
  afterEach(() => {
    stopServers();
  });

  it("shows update notification after command output when newer version is available", async () => {
    releaseResponse = { status: 200, body: [{ tag_name: "cli/v99.0.0" }] };
    await startServers();
    const tempDir = mkdtempSync(join(tmpdir(), "scope-uc-"));
    try {
      const { stdout, stderr } = await runBundle(["run", "list"], tempDir);
      expect(stdout).toContain("No requests found");
      expect(stderr).toContain("A newer version of scope is available: 99.0.0");
      expect(stderr).toContain("current: 0.0.0-dev");
      expect(stderr).toContain("scope update");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not show notification when version is current", async () => {
    releaseResponse = { status: 200, body: [{ tag_name: "cli/v0.0.0-dev" }] };
    await startServers();
    const tempDir = mkdtempSync(join(tmpdir(), "scope-uc-"));
    try {
      const { stderr } = await runBundle(["run", "list"], tempDir);
      expect(stderr).not.toContain("newer version");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not show notification when current is newer than release", async () => {
    releaseResponse = { status: 200, body: [{ tag_name: "cli/v0.0.0-alpha" }] };
    await startServers();
    const tempDir = mkdtempSync(join(tmpdir(), "scope-uc-"));
    try {
      const { stderr } = await runBundle(["run", "list"], tempDir);
      expect(stderr).not.toContain("newer version");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("suppressed when SCOPE_NO_UPDATE_CHECK=1", async () => {
    releaseResponse = { status: 200, body: [{ tag_name: "cli/v99.0.0" }] };
    await startServers();
    const tempDir = mkdtempSync(join(tmpdir(), "scope-uc-"));
    try {
      const isolatedBundle = join(tempDir, "scope.mjs");
      copyFileSync(BUNDLE_PATH, isolatedBundle);
      const { stderr } = await execFileAsync(process.execPath, ["--no-global-search-paths", isolatedBundle, "run", "list"], {
        cwd: tempDir,
        env: {
          ...process.env,
          NODE_PATH: "",
          NODE_OPTIONS: "",
          SCOPE_NO_UPDATE_CHECK: "1",
          SCOPE_RELEASES_URL: `http://127.0.0.1:${releasePort}`,
          SCOPE_API_URL: `http://127.0.0.1:${apiPort}`,
          SCOPE_PROJECT: "test-project",
          HOME: tempDir,
        },
        timeout: 10000,
      });
      expect(stderr).not.toContain("newer version");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("silently handles server errors", async () => {
    releaseResponse = { status: 500, body: { error: "internal" } };
    await startServers();
    const tempDir = mkdtempSync(join(tmpdir(), "scope-uc-"));
    try {
      const { stderr } = await runBundle(["run", "list"], tempDir);
      expect(stderr).not.toContain("newer version");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("silently handles invalid semver in tag_name", async () => {
    releaseResponse = { status: 200, body: [{ tag_name: "not-a-version" }] };
    await startServers();
    const tempDir = mkdtempSync(join(tmpdir(), "scope-uc-"));
    try {
      const { stderr } = await runBundle(["run", "list"], tempDir);
      expect(stderr).not.toContain("newer version");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("respects cooldown — second invocation does not notify again", async () => {
    releaseResponse = { status: 200, body: [{ tag_name: "cli/v99.0.0" }] };
    await startServers();
    const tempDir = mkdtempSync(join(tmpdir(), "scope-uc-"));
    try {
      // First run — should show
      const run1 = await runBundle(["run", "list"], tempDir);
      expect(run1.stderr).toContain("newer version");

      // Second run — cooldown should suppress
      const run2 = await runBundle(["run", "list"], tempDir);
      expect(run2.stderr).not.toContain("newer version");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles pre-release versions correctly", async () => {
    releaseResponse = { status: 200, body: [{ tag_name: "cli/v2.0.0-beta.1" }] };
    await startServers();
    const tempDir = mkdtempSync(join(tmpdir(), "scope-uc-"));
    try {
      const { stderr } = await runBundle(["run", "list"], tempDir);
      // 2.0.0-beta.1 > 0.0.0-dev in semver
      expect(stderr).toContain("2.0.0-beta.1");
      expect(stderr).toContain("scope update");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("checks again after cooldown period expires", async () => {
    releaseResponse = { status: 200, body: [{ tag_name: "cli/v99.0.0" }] };
    await startServers();
    const tempDir = mkdtempSync(join(tmpdir(), "scope-uc-"));
    try {
      // Write a state file with lastCheck > 1 hour ago
      const configDir = join(tempDir, ".config", "scope");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(configDir, { recursive: true });
      const expiredTimestamp = Date.now() - 61 * 60 * 1000; // 61 minutes ago
      writeFileSync(
        join(configDir, "update-check.json"),
        JSON.stringify({ lastCheck: expiredTimestamp }) + "\n",
      );

      // Should check again since cooldown expired
      const { stderr } = await runBundle(["run", "list"], tempDir);
      expect(stderr).toContain("newer version");
      expect(stderr).toContain("99.0.0");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
