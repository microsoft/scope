// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { execSync } from "node:child_process";
import { chmodSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import semver from "semver";
import { getCliName } from "../utils/shared.js";
import { fetchLatestVersion, RELEASES_REPO } from "../utils/update-check.js";

function getCliVersion(): string {
  return process.env.SCOPE_CLI_VERSION ?? "0.1.0-dev";
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update the CLI to the latest version")
    .option("-f, --force", "Force reinstall even if already up to date")
    .action(async (opts: { force?: boolean }) => {
      const cli = getCliName();
      if (cli !== "scope") {
        console.error(
          "The update command is only available for standalone installations.\n" +
            "In dev mode, pull the latest code and rebuild instead.",
        );
        process.exit(1);
      }

      console.log("Checking for updates...");

      const currentVersion = getCliVersion();
      let targetTag: string | undefined;

      const latest = await fetchLatestVersion();
      if (!opts.force) {
        if (latest && semver.valid(currentVersion)) {
          if (!semver.gt(latest, currentVersion)) {
            console.log(`✓ Already up to date (v${currentVersion})`);
            return;
          }
          console.log(`→ New version available: ${latest} (current: ${currentVersion})`);
        }
      }
      targetTag = latest ? `cli/v${latest}` : undefined;

      if (!targetTag) {
        // Resolve tag via gh release list
        try {
          targetTag = execSync(
            `gh release list --repo ${RELEASES_REPO} --json tagName -q '[.[].tagName | select(startswith("cli/v"))][0]'`,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          ).trim();
        } catch { /* ignore */ }
      }

      if (!targetTag) {
        console.error("Could not determine the latest CLI release tag.");
        process.exit(1);
      }

      // Determine where the currently running binary lives
      const currentBin = resolve(process.argv[1]);
      const installDir = dirname(currentBin);
      const binaryName = basename(currentBin);
      const tmpFile = join(installDir, `.${binaryName}.tmp`);

      try {
        // Download scope.mjs to a temp file, then atomically replace
        execSync(
          `gh release download "${targetTag}" --repo ${RELEASES_REPO} --pattern scope.mjs -O "${tmpFile}" --clobber`,
          { stdio: "inherit" },
        );
        chmodSync(tmpFile, 0o755);
        renameSync(tmpFile, currentBin);

        // Verify
        const newVersion = execSync(`"${currentBin}" --version`, { encoding: "utf-8" }).trim();
        console.log(`✓ Updated scope to v${newVersion} at ${currentBin}`);
      } catch {
        // Clean up temp file on failure
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
        console.error(
          "\nUpdate failed. You can reinstall manually:\n" +
            "  gh api repos/" + RELEASES_REPO + "/contents/website/install-cli.sh -H \"Accept: application/vnd.github.raw\" | bash",
        );
        process.exit(1);
      }
    });
}
