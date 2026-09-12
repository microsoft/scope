// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HostWorkers, hostCaptureSetting, isHostCancellation, parseDiscoveredHost, signalHostProcess } from "./host.js";

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
    it("enables capture when the local gateway API is configured", () => {
      expect(Boolean(hostCaptureSetting({}))).toBe(false);
      expect(hostCaptureSetting({ DEV_PROXY_ENABLED: "true" })).toBe("true");
      expect(hostCaptureSetting({ DEV_PROXY_API_URL: "http://127.0.0.1:18000" })).toBe("true");
      expect(hostCaptureSetting({ DEV_PROXY_ENABLED: "false", DEV_PROXY_API_URL: "http://127.0.0.1:18000" })).toBe("false");
      expect(hostCaptureSetting({ DEV_PROXY_ENABLED: "0" })).toBe("0");
      expect(Boolean(hostCaptureSetting({ DEV_PROXY_ENABLED: "" }))).toBe(false);
    });
  });

  describe("host cancellation supervision", () => {
    it("recognizes only the selected worker's existing cancellation messages", () => {
      const id = "coder-acp-copilot-host";
      expect(isHostCancellation(`[${id}] Run run-1 cancelled via pub/sub — exiting process\n`, id)).toBe(true);
      expect(isHostCancellation(`[${id}] Run run-1 cancel detected via key fallback — exiting process\r\n`, id)).toBe(true);
      expect(isHostCancellation("genuine runtime failure", id)).toBe(false);
      expect(isHostCancellation("[coder-acp-claude-code-host] Run run-1 cancelled via pub/sub — exiting process", id)).toBe(false);
    });

    it.each([
      { reason: "cancellation", cancel: true },
      { reason: "runtime failure", cancel: false },
    ])("classifies post-ready exit1 ($reason) and keeps runtime files in the data directory", async ({ cancel }) => {
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
        const backend = {
          PROXY_BACKEND: "gateway",
          DEV_PROXY_ENABLED: "true",
          DEV_PROXY_API_URL: "http://127.0.0.1:18900",
        };
        await writeFile(join(dist, `${id}.js`), `
          import { readFileSync, writeFileSync } from 'node:fs';
          import { join } from 'node:path';
          const root = process.env.SCOPE_HOST_WORKSPACE_ROOT;
          const file = join(root, 'starts');
          let count = 0;
          try { count = Number(readFileSync(file, 'utf8')); } catch {}
          writeFileSync(file, String(count + 1));
          writeFileSync(join(root, 'runtime-env.json'), JSON.stringify({
            TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
            PROXY_BACKEND: process.env.PROXY_BACKEND,
            DEV_PROXY_ENABLED: process.env.DEV_PROXY_ENABLED,
            DEV_PROXY_API_URL: process.env.DEV_PROXY_API_URL
          }));
          console.log('[${id}] Ensured queue exists: queue-${id}');
          console.log('[${id}] Connected to MongoDB');
          if (count === 0) setTimeout(() => {
            if (${cancel}) {
              const marker = Buffer.from('[${id}] Run run-1 cancelled via pub/sub — exiting process\\n');
              const split = marker.indexOf(Buffer.from('—')) + 1;
              process.stdout.write(marker.subarray(0, split));
              setTimeout(() => { process.stdout.write(marker.subarray(split)); process.exit(1); }, 5);
            } else {
              console.error('genuine runtime failure');
              process.exit(1);
            }
          }, 50);
          else {
            process.once('SIGTERM', () => process.exit(0));
            setInterval(() => {}, 1000);
          }
        `);
        await workers.start(id, { enabled: true, consent: true }, backend);
        const workspace = join(data, "workspaces", id);
        if (cancel) {
          await vi.waitFor(async () => expect(await readFile(join(workspace, "starts"), "utf8")).toBe("2"), { timeout: 4000 });
        } else {
          await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 4000 });
          expect(failures[0]).toContain("genuine runtime failure");
        }
        const runtime = join(data, "runtime", id);
        expect(JSON.parse(await readFile(join(workspace, "runtime-env.json"), "utf8")) as unknown).toEqual({
          TMPDIR: runtime, TMP: runtime, TEMP: runtime,
          ...backend,
        });
        expect((await stat(runtime)).isDirectory()).toBe(true);
        if (cancel) expect(failures).toEqual([]);
        await workers.stop(id);
        await new Promise(resolve => setTimeout(resolve, 600));
        expect(await readFile(join(workspace, "starts"), "utf8")).toBe(cancel ? "2" : "1");
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
