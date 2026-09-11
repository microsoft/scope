// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ServerPaths {
  config: string;
  data: string;
  cache: string;
  runtime: string;
  owner: string;
}

export function serverPaths(dataDir?: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): ServerPaths {
  const xdg = (name: string, fallback: string): string => {
    const value = env[name];
    return value && isAbsolute(value) ? value : join(home, fallback);
  };
  const config = join(xdg("XDG_CONFIG_HOME", ".config"), "scope-server");
  return {
    config,
    data: dataDir ? resolve(dataDir) : join(xdg("XDG_DATA_HOME", ".local/share"), "scope-server"),
    cache: join(xdg("XDG_CACHE_HOME", ".cache"), "scope-server"),
    // Independent of --data-dir and XDG overrides: only one server per OS user.
    runtime: join(home, ".local", "state", "scope-server"),
    owner: `scope-${createHash("sha256").update(home).digest("hex").slice(0, 12)}`,
  };
}

export async function preparePaths(paths: ServerPaths): Promise<void> {
  for (const directory of [paths.config, paths.data, paths.cache, paths.runtime]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.${process.pid}.pending`;
  try {
    await open(pending, "wx", 0o600).then(async file => {
      try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await file.close(); }
    });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function acquireLock(paths: ServerPaths): Promise<() => Promise<void>> {
  const path = join(paths.runtime, "launcher.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
      const raw = await readFile(path, "utf8");
      const pid = Number(raw);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`Invalid launcher lock at ${path}; inspect it before removing it.`);
      }

      try {
        process.kill(pid, 0);
      } catch (probeError) {
        if (typeof probeError === "object" && probeError !== null && "code" in probeError && probeError.code === "ESRCH") {
          await rm(path);
          continue;
        }
        throw probeError;
      }
      throw new Error(`Scope Server is already running (PID ${pid}). Use scope-server status or scope-server stop.`);
    }
  }
  throw new Error("Could not acquire the Scope Server launcher lock");
}

export async function readPorts(config: string): Promise<{ api?: number; portal?: number }> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(config, "ports.json"), "utf8")); }
  catch (error) { if (isMissing(error)) return {}; throw error; }
  if (typeof value !== "object" || value === null ||
    !Object.entries(value).every(([key, port]) =>
      ["api", "portal"].includes(key) && typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw new Error("Invalid saved server ports");
  }
  return value as { api?: number; portal?: number };
}
