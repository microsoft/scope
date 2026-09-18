// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// Mock fs operations used during update
vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock the update-check module
vi.mock("../utils/update-check.js", () => ({
  fetchLatestVersion: vi.fn(),
  RELEASES_REPO: "microsoft/scope",
}));

import { Command } from "commander";
import { execSync } from "node:child_process";
import { chmodSync, renameSync, unlinkSync } from "node:fs";
import { fetchLatestVersion } from "../utils/update-check.js";
import { registerUpdateCommand } from "./update.js";

const mockedExecSync = vi.mocked(execSync);
const mockedFetchLatestVersion = vi.mocked(fetchLatestVersion);
const mockedChmodSync = vi.mocked(chmodSync);
const mockedRenameSync = vi.mocked(renameSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);

describe("update command", () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride(); // throw instead of process.exit
    registerUpdateCommand(program);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Simulate bundled CLI
    process.env.SCOPE_CLI_VERSION = "0.2.0";
    // Mock execSync: gh release download returns void (stdio: inherit),
    // version check returns version string, gh release list returns tag
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("--version")) {
        return "0.3.0\n";
      }
      if (typeof cmd === "string" && cmd.includes("gh release list")) {
        return "cli/v0.3.0\n";
      }
      return Buffer.from("");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SCOPE_CLI_VERSION;
  });

  it("skips update when already on latest version", async () => {
    mockedFetchLatestVersion.mockResolvedValue("0.2.0");

    await program.parseAsync(["node", "scope", "update"]);

    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Already up to date"),
    );
  });

  it("skips update when on a newer version than latest", async () => {
    mockedFetchLatestVersion.mockResolvedValue("0.1.9");

    await program.parseAsync(["node", "scope", "update"]);

    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Already up to date"),
    );
  });

  it("proceeds with update when a newer version is available", async () => {
    mockedFetchLatestVersion.mockResolvedValue("0.3.0");

    await program.parseAsync(["node", "scope", "update"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("New version available: 0.3.0"),
    );
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('gh release download "cli/v0.3.0" --repo microsoft/scope'),
      expect.anything(),
    );
  });

  it("proceeds with update when --force is passed even if up to date", async () => {
    mockedFetchLatestVersion.mockResolvedValue("0.2.0");

    await program.parseAsync(["node", "scope", "update", "--force"]);

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh release download"),
      expect.anything(),
    );
  });

  it("proceeds with update when version check fails", async () => {
    mockedFetchLatestVersion.mockResolvedValue(undefined);

    await program.parseAsync(["node", "scope", "update"]);

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh release list --repo microsoft/scope"),
      expect.anything(),
    );
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('gh release download "cli/v0.3.0" --repo microsoft/scope'),
      expect.anything(),
    );
  });

  it("rejects update in dev mode", async () => {
    delete process.env.SCOPE_CLI_VERSION;

    await expect(
      program.parseAsync(["node", "scope", "update"]),
    ).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("only available for standalone installations"),
    );
  });

  it("sets chmod 755 and renames atomically on successful download", async () => {
    mockedFetchLatestVersion.mockResolvedValue("0.3.0");

    await program.parseAsync(["node", "scope", "update"]);

    expect(mockedChmodSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      0o755,
    );
    expect(mockedRenameSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.any(String),
    );
  });

  it("cleans up temp file and exits 1 on download failure", async () => {
    mockedFetchLatestVersion.mockResolvedValue("0.3.0");
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("gh release download")) {
        throw new Error("download failed");
      }
      return Buffer.from("");
    });

    await expect(
      program.parseAsync(["node", "scope", "update"]),
    ).rejects.toThrow("process.exit");
    expect(mockedUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'gh api repos/microsoft/scope/contents/website/install-cli.sh -H "Accept: application/vnd.github.raw" | bash',
      ),
    );
  });

  it("verifies new version after install", async () => {
    mockedFetchLatestVersion.mockResolvedValue("0.3.0");

    await program.parseAsync(["node", "scope", "update"]);

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--version"),
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Updated scope to v0.3.0"),
    );
  });
});
