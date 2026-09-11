// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HostWorkers, hostCaptureSetting, parseDiscoveredHost, signalHostProcess } from "./host.js";

afterEach(() => vi.restoreAllMocks());

const detected = {
  workerType: "coder-acp-copilot-host", executable: "/usr/bin/copilot", version: "1.2.3",
  agentVersion: "copilot-1.2.3", componentVersions: { COPILOT_CLI_VERSION: "1.2.3" },
};

describe("native ACP model metadata", () => {
  it("accepts only models actually advertised by the installed agent", () => {
    const metadata = {
      ...detected,
      supportedModels: ["native-model"],
      models: [{ id: "native-model", name: "Native model" }],
      defaultModel: "native-model",
    };
    expect(parseDiscoveredHost(metadata)).toEqual(metadata);
    expect(() => parseDiscoveredHost({ ...metadata, defaultModel: "invented" })).toThrow("valid ACP");
    expect(() => parseDiscoveredHost({ ...metadata, models: [] })).toThrow("valid ACP");
    expect(() => parseDiscoveredHost({ ...metadata, supportedModels: ["native-model", "missing"] })).toThrow("incomplete");
    expect(() => parseDiscoveredHost({ ...metadata, models: [{ id: "invented", name: "Invalid" }] })).toThrow("valid ACP");
  });

  it("accepts native supported-model IDs without requiring optional display metadata", () => {
    expect(parseDiscoveredHost({ ...detected, supportedModels: ["native-model"], defaultModel: "native-model" })).toMatchObject({
      supportedModels: ["native-model"], defaultModel: "native-model",
      models: [{ id: "native-model" }],
    });
  });
});

describe("owned host process groups", () => {
  it("signals the worker's process group, not the launcher's group", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = { pid: 4321, kill: vi.fn().mockReturnValue(true) };
    signalHostProcess(child, "SIGTERM", true);
    expect(kill).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  describe("host proxy configuration", () => {
    it("does not require an unconfigured gateway, but honors explicit capture settings", () => {
      expect(hostCaptureSetting({})).toBe("false");
      expect(hostCaptureSetting({ DEV_PROXY_ENABLED: "true" })).toBe("true");
      expect(hostCaptureSetting({ DEV_PROXY_API_URL: "http://127.0.0.1:18000" })).toBe("true");
      expect(hostCaptureSetting({ DEV_PROXY_ENABLED: "false", DEV_PROXY_API_URL: "http://127.0.0.1:18000" })).toBe("false");
    });
  });

  describe("host cancellation supervision", () => {
    it("restarts exit-code-1 cancellation and keeps runtime files in the data directory", async () => {
      const root = resolve("apps/server/.test-state", randomUUID());
      const dist = join(root, "dist");
      const data = join(root, "data");
      const id = "coder-acp-copilot-host";
      const failures: string[] = [];
      const workers = new HostWorkers(dist, data, (_id, error) => failures.push(error));
      try {
        await mkdir(dist, { recursive: true });
        await mkdir(data, { recursive: true });
        await writeFile(join(root, "package.json"), '{"type":"module"}');
        await copyFile(resolve("apps/server/src/host-lifecycle.ts"), join(dist, "host-lifecycle.js"));
        await writeFile(join(dist, `${id}.js`), `
          import { readFileSync, writeFileSync } from 'node:fs';
          import { join } from 'node:path';
          const root = process.env.SCOPE_HOST_WORKSPACE_ROOT;
          const file = join(root, 'starts');
          let count = 0;
          try { count = Number(readFileSync(file, 'utf8')); } catch {}
          writeFileSync(file, String(count + 1));
          writeFileSync(join(root, 'runtime-env.json'), JSON.stringify({
            TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP
          }));
          console.log('[${id}] Ensured queue exists: queue-${id}');
          console.log('[${id}] Connected to MongoDB');
          if (count === 0) setTimeout(() => process.exit(1), 50);
          else {
            process.once('SIGTERM', () => process.exit(0));
            setInterval(() => {}, 1000);
          }
        `);
        await workers.start(id, { enabled: true, consent: true }, {});
        const workspace = join(data, "workspaces", id);
        await vi.waitFor(async () => expect(await readFile(join(workspace, "starts"), "utf8")).toBe("2"), { timeout: 4000 });
        const runtime = join(data, "runtime", id);
        expect(JSON.parse(await readFile(join(workspace, "runtime-env.json"), "utf8")) as unknown).toEqual({
          TMPDIR: runtime, TMP: runtime, TEMP: runtime,
        });
        expect((await stat(runtime)).isDirectory()).toBe(true);
        expect(failures).toEqual([]);
        await workers.stop(id);
        await new Promise(resolve => setTimeout(resolve, 600));
        expect(await readFile(join(workspace, "starts"), "utf8")).toBe("2");
      } finally {
        await workers.stop(id);
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("tolerates an already exited group but reports permission errors", () => {
    const child = { pid: 4321, kill: vi.fn().mockReturnValue(true) };
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("exited"), { code: "ESRCH" });
    });
    expect(() => signalHostProcess(child, "SIGKILL", true)).not.toThrow();
    kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(() => signalHostProcess(child, "SIGKILL", true)).toThrow("denied");
  });
});
