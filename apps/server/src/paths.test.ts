// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, preparePaths, readPorts, serverPaths, writeJson } from "./paths.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("persistent server paths", () => {
  it("uses separate XDG roots, ignores relative XDG roots, and keeps a per-user singleton", () => {
    const initial = serverPaths(undefined, {}, "/home/person");
    expect(initial.config).toBe("/home/person/.config/scope-server");
    expect(initial.data).toBe("/home/person/.local/share/scope-server");
    const custom = serverPaths("/data/scope", { XDG_CONFIG_HOME: "/settings", XDG_CACHE_HOME: "relative" }, "/home/person");
    expect(custom.config).toBe("/settings/scope-server");
    expect(custom.data).toBe("/data/scope");
    expect(custom.cache).toBe("/home/person/.cache/scope-server");
    expect(custom.runtime).toBe(initial.runtime);
    expect(custom.owner).toBe(initial.owner);
  });

  it("rejects concurrent launchers even when data paths differ, then permits restart", async () => {
    const directory = resolve("apps/server/.test-state", randomUUID());
    directories.push(directory);
    const paths = serverPaths(undefined, {}, directory);
    await preparePaths(paths);
    const release = await acquireLock(paths);
    await expect(acquireLock({ ...paths, data: `${directory}/other-data` })).rejects.toThrow("already running");
    await release();
    const releaseAgain = await acquireLock(paths);
    await releaseAgain();
  });

  it("writes private, atomic configuration files", async () => {
    const directory = resolve("apps/server/.test-state", randomUUID());
    directories.push(directory);
    const path = `${directory}/config.json`;
    await writeJson(path, { selected: true });
    expect(JSON.parse(await readFile(path, "utf8")) as unknown).toEqual({ selected: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("remembers actual API/Portal ports so normal restart preserves client URLs", async () => {
    const directory = resolve("apps/server/.test-state", randomUUID());
    directories.push(directory);
    expect(await readPorts(directory)).toEqual({});
    await writeJson(`${directory}/ports.json`, { api: 43127, portal: 43128 });
    expect(await readPorts(directory)).toEqual({ api: 43127, portal: 43128 });
    await writeJson(`${directory}/ports.json`, { api: -1 });
    await expect(readPorts(directory)).rejects.toThrow("Invalid saved");
  });
});
