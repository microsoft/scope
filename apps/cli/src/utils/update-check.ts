// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Non-blocking check for newer CLI versions on GitHub Releases.
 * Starts the check in the background and returns a flush function
 * that should be awaited after the command completes to print the notification.
 * Suppressed by SCOPE_NO_UPDATE_CHECK=1 environment variable.
 * Checks at most once per hour (cooldown stored in update-check.json in the CLI config dir).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import semver from "semver";
import { environmentConfigDir } from "./environments.js";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function stateFile(): string {
  return join(environmentConfigDir(), "update-check.json");
}

function shouldCheck(): boolean {
  try {
    const file = stateFile();
    if (!existsSync(file)) return true;
    const state = JSON.parse(readFileSync(file, "utf-8"));
    const lastCheck = state.lastCheck ?? 0;
    return Date.now() - lastCheck >= UPDATE_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function recordCheck(): void {
  try {
    const dir = environmentConfigDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(stateFile(), JSON.stringify({ lastCheck: Date.now() }) + "\n");
  } catch {
    // Best-effort — don't fail if we can't write state
  }
}

/**
 * Starts the update check in the background.
 * Returns a function that resolves with the update message (if any).
 * Also registers a process 'exit' handler to print the message even if
 * Commander calls process.exit() before the caller can await.
 */
export function checkForUpdates(currentVersion: string): () => Promise<void> {
  if (process.env.SCOPE_NO_UPDATE_CHECK === "1") return async () => {};
  if (!shouldCheck()) return async () => {};

  let message: string | undefined;
  const pending = checkLatestVersion(currentVersion).then((msg) => {
    message = msg;
  });

  // Print on exit even if process.exit() is called (e.g., --help, --version)
  process.on("exit", () => {
    if (message) process.stderr.write(message);
  });

  return async () => {
    await pending;
    // Print and clear so the exit handler doesn't double-print
    if (message) {
      process.stderr.write(message);
      message = undefined;
    }
  };
}

export const RELEASES_REPO = "microsoft/scope";

export const RELEASES_URL =
  process.env.SCOPE_RELEASES_URL ||
  `https://api.github.com/repos/${RELEASES_REPO}/releases`;

/**
 * Fetch the latest released CLI version.
 * Only considers releases with a `cli/v*` tag prefix.
 * Uses `gh release list`, falling back to the public REST API.
 * Returns the version string (without prefix) or undefined on failure.
 * Timeout defaults to 5000ms but can be overridden (background check uses 2000ms).
 */
export async function fetchLatestVersion(timeoutMs = 5000): Promise<string | undefined> {
  // Skip gh CLI when a custom SCOPE_RELEASES_URL is set (e.g. in tests)
  if (!process.env.SCOPE_RELEASES_URL) {
    // Prefer gh CLI when available; its configured token also avoids anonymous rate limits.
    try {
      const tag = execSync(
        `gh release list --repo ${RELEASES_REPO} --json tagName -q '[.[].tagName | select(startswith("cli/v"))][0]'`,
        { encoding: "utf-8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (!tag.startsWith("cli/v")) return undefined;
      const version = tag.slice("cli/v".length);
      if (semver.valid(version)) return version;
    } catch {
      // gh not available or failed — fall through to REST API
    }
  }

  // Public releases can be read anonymously; a GitHub token is optional.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) {
      headers.Authorization = `token ${token}`;
    }

    // Intentional direct fetch: this targets the external GitHub Releases API
    // with its own `token` auth and must NOT route through apiFetch(), which
    // injects the Scope SCOPE_TOKEN bearer and would leak it to github.com.
    const res = await fetch(RELEASES_URL, {
      signal: controller.signal,
      headers,
    });

    if (!res.ok) return undefined;

    const data = (await res.json()) as Array<{ tag_name?: string }> | { tag_name?: string };
    // Handle both array (releases list) and single object (test mock compatibility)
    const releases = Array.isArray(data) ? data : [data];
    const match = releases.find((r) => r.tag_name?.startsWith("cli/v"));
    if (!match?.tag_name) return undefined;

    const latest = match.tag_name.slice("cli/v".length);
    return semver.valid(latest) ? latest : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkLatestVersion(currentVersion: string): Promise<string | undefined> {
  try {
    const latest = await fetchLatestVersion(2000);
    if (latest && semver.gt(latest, currentVersion)) {
      return (
        `\n  A newer version of scope is available: ${latest} (current: ${currentVersion})\n` +
        `  Run: scope update\n\n`
      );
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    recordCheck();
  }
}
