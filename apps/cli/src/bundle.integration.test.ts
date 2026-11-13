// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { resolve, join, dirname } from "node:path";
import { existsSync, copyFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const BUNDLE_PATH = resolve(import.meta.dirname, "../dist/scope.mjs");

if (!existsSync(BUNDLE_PATH)) {
  throw new Error(
    `Bundle not found at ${BUNDLE_PATH}. Run "pnpm build:cli" first.`
  );
}

/** Canned API responses for the mock server */
const MOCK_RESPONSES: Record<string, unknown> = {
  "/api/v1/requests": {
    data: [
      {
        id: "req-test-001",
        workerType: "coder-acp-copilot",
        run: { status: "done", outcome: "succeeded" },
        submissionId: "sub-abc123",
      },
    ],
    pageInfo: { hasNextPage: false, hasPreviousPage: false },
  },
  "/api/v1/criteria": [
    {
      id: "has_button",
      prompt: "Page has a button element",
      dependsOn: [],
    },
  ],
};

let server: Server;
let port: number;
let bundleDir: string;
let isolatedBundle: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "scope-bundle-"));
  isolatedBundle = join(bundleDir, "scope.mjs");
  copyFileSync(BUNDLE_PATH, isolatedBundle);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const response = MOCK_RESPONSES[url.pathname];
    if (response) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  server?.close();
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

async function runScope(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--no-global-search-paths", isolatedBundle, ...args], {
    cwd: bundleDir,
    env: {
      ...process.env,
      NODE_PATH: "",
      NODE_OPTIONS: "",
      SCOPE_NO_UPDATE_CHECK: "1",
      SCOPE_API_URL: `http://127.0.0.1:${port}`,
      SCOPE_PROJECT: "test-project",
      ...env,
    },
    timeout: 10000,
  });
  return { stdout, stderr };
}

describe("Bundle integration tests", () => {
  it("--version prints the version", async () => {
    const { stdout } = await runScope(["--version"], { SCOPE_API_URL: "" });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help shows usage information", async () => {
    const { stdout } = await runScope(["--help"], { SCOPE_API_URL: "" });
    expect(stdout).toContain("scope");
    expect(stdout).toContain("Scope — The AI Agentic Experience Evaluation Platform");
    expect(stdout).not.toContain("MS Scope");
    expect(stdout).toContain("run");
    expect(stdout).toContain("criteria");
    expect(stdout).not.toContain("https://msscope.azurewebsites.net");
    expect(stdout).not.toContain("http://localhost:3100");
  });

  it("run list fetches from mock API and formats output", async () => {
    const { stdout } = await runScope(["run", "list"]);
    expect(stdout).toContain("req-test-001");
    expect(stdout).toContain("coder-acp-copilot");
    expect(stdout).toContain("done");
  });

  it("criteria list fetches from mock API", async () => {
    const { stdout } = await runScope(["criteria", "list", "-u", `http://127.0.0.1:${port}`], {
      SCOPE_API_URL: "http://127.0.0.1:1",
    });
    expect(stdout).toContain("has_button");
  });

  it("run list --output json returns valid JSON", async () => {
    const { stdout } = await runScope(["run", "list", "-u", `http://127.0.0.1:${port}`, "-o", "json"]);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe("req-test-001");
  });

  it("accepts an explicit URL without environment configuration", async () => {
    const { stdout } = await runScope(["run", "list", "--url", `http://127.0.0.1:${port}`], {
      SCOPE_API_URL: "",
    });
    expect(stdout).toContain("req-test-001");
  });

  it.each([
    ["project", "list"],
    ["run", "list"],
    ["run", "logs", "-i", "req-test-001"],
    ["run", "submit", "-m", "Test task", "-w", "coder-acp-copilot", "--no-stream"],
    ["criteria", "export"],
    ["mcp", "server", "list"],
    ["mcp", "server", "create", "--id", "test", "--name", "Test", "--type", "http", "--url", "https://mcp.example.com"],
  ])("requires an API URL for %j", async (...args) => {
    await expect(runScope(args, {
      SCOPE_API_URL: "",
      SCOPE_DEFAULT_API_URL: "http://127.0.0.1:1",
      SCOPE_API_PORT: "1",
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("No API URL configured. Set SCOPE_API_URL or pass -u/--url"),
    });
  });

  it("keeps update help usable without an API URL", async () => {
    const { stdout } = await runScope(["update", "--help"], { SCOPE_API_URL: "" });
    expect(stdout).toContain("update");
  });

  it("works when installed as 'scope' (no .mjs extension)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    const scopeBin = join(tempDir, "scope");
    try {
      copyFileSync(BUNDLE_PATH, scopeBin);
      chmodSync(scopeBin, 0o755);
      const { stdout } = await execFileAsync(process.execPath, ["--no-global-search-paths", scopeBin, "--version"], {
        cwd: tempDir,
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", SCOPE_API_URL: "", SCOPE_NO_UPDATE_CHECK: "1" },
        timeout: 10000,
      });
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// Keep updater cases in the bundle suite invoked by CI and CLI publication.
describe.skipIf(process.platform === "win32")("standalone CLI update validation", () => {
  let updateDirectory: string | undefined;
  let releaseServer: Server | undefined;

  afterEach(async () => {
    if (releaseServer) await new Promise<void>((resolveClose) => releaseServer!.close(() => resolveClose()));
    if (updateDirectory) rmSync(updateDirectory, { recursive: true, force: true });
    releaseServer = undefined;
    updateDirectory = undefined;
  });

  /** Exercise the real installed bundle with a local release list and fake downloader. */
  async function runUpdate(downloadedSource: string) {
    updateDirectory = mkdtempSync(join(tmpdir(), "scope-update-"));
    const installedPath = join(updateDirectory, "scope");
    copyFileSync(BUNDLE_PATH, installedPath);
    const before = readFileSync(installedPath, "utf-8");

    // The fake gh only writes the supplied synthetic bundle to the requested path.
    const downloaderPath = join(updateDirectory, "gh");
    writeFileSync(downloaderPath, `#!/usr/bin/env node
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  if (args[0] !== "release" || args[1] !== "download") process.exit(2);
  fs.writeFileSync(args[args.indexOf("-O") + 1], process.env.SCOPE_TEST_BUNDLE);
  `);
    chmodSync(downloaderPath, 0o755);

    releaseServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{ tag_name: "cli/v9.0.0" }]));
    });
    await new Promise<void>((resolveListen) => releaseServer!.listen(0, "127.0.0.1", resolveListen));
    const address = releaseServer.address();
    if (!address || typeof address === "string") throw new Error("Missing mock release server port");

    let failed = false;
    try {
      await execFileAsync(process.execPath, ["--no-global-search-paths", installedPath, "update"], {
        cwd: updateDirectory,
        env: {
          ...process.env,
          NODE_PATH: "",
          NODE_OPTIONS: "",
          PATH: `${updateDirectory}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          SCOPE_NO_UPDATE_CHECK: "1",
          SCOPE_RELEASES_URL: `http://127.0.0.1:${address.port}`,
          SCOPE_TEST_BUNDLE: downloadedSource,
        },
        timeout: 15_000,
      });
    } catch {
      failed = true;
    }
    return { failed, before, after: readFileSync(installedPath, "utf-8"), files: readdirSync(updateDirectory) };
  }

  it.each([
    ["invalid JavaScript", "#!/usr/bin/env node\nthis is not JavaScript"],
    ["missing executable header", 'console.log("9.0.0");'],
    ["wrong version", '#!/usr/bin/env node\nconsole.log("8.0.0");'],
    [
      "a bundle that ignores graceful termination",
      '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {}); console.log("9.0.0"); setInterval(() => {}, 1000);',
    ],
  ])("preserves the installed CLI for %s", async (_description, downloadedSource) => {
    const result = await runUpdate(downloadedSource);
    expect(result.failed).toBe(true);
    expect(result.after).toBe(result.before);
    expect(result.files).toEqual(["gh", "scope"]);
  });

  it("installs a matching executable bundle", async () => {
    const downloadedSource = '#!/usr/bin/env node\nconsole.log("9.0.0");';
    const result = await runUpdate(downloadedSource);
    expect(result.failed).toBe(false);
    expect(result.after).toBe(downloadedSource);
    expect(result.files).toEqual(["gh", "scope"]);
    const { stdout } = await execFileAsync(join(updateDirectory!, "scope"), ["--version"], {
      timeout: 10_000,
    });
    expect(stdout.trim()).toBe("9.0.0");
  });
});
