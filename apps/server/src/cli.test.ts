// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const root = `${process.cwd()}/apps/server/.test-state/cli-lifecycle`;
  return {
    paths: { config: `${root}/config`, data: `${root}/data`, cache: `${root}/cache`, runtime: `${root}/runtime`, owner: "test" },
    release: vi.fn(async () => {}),
    removeRuntime: vi.fn(async () => {}),
    agentClose: vi.fn(async () => {}),
    controlClose: vi.fn(async () => {}),
    cancel: vi.fn(),
    connect: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => { throw new Error("Lifecycle tests must not execute commands"); }),
}));
vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => { throw new Error("Unexpected file read"); }),
  rm: mocks.removeRuntime,
  writeFile: vi.fn(async () => {}),
}));
vi.mock("docker-orchestrator", () => ({
  Docker: class {},
  Orchestrator: class {
    cancel = mocks.cancel;
    stop = mocks.stop;
    start = mocks.start;
    connect = mocks.connect;
    hostPort = vi.fn(async () => 45000);
    bridgeGateway = vi.fn(async () => "127.0.0.1");
  },
}));
vi.mock("./agents.js", () => ({
  AgentManager: class {
    load = vi.fn(async () => true);
    activate = vi.fn(async () => {});
    snapshot = vi.fn(() => ({ agents: [] }));
    close = mocks.agentClose;
  },
}));
vi.mock("./api.js", () => ({
  parseScannerModels: vi.fn(), registerAgent: vi.fn(), registerModels: vi.fn(), setAgentAvailable: vi.fn(),
}));
vi.mock("./control.js", () => ({
  startControl: vi.fn(async () => ({ port: 45001, listenHost: "127.0.0.1", close: mocks.controlClose })),
}));
vi.mock("./control-address.js", () => ({
  controlAddress: vi.fn(() => ({ listenHost: "127.0.0.1", containerHost: "host.docker.internal" })),
  isLocalControlAddress: vi.fn(() => true),
}));
vi.mock("./host.js", () => ({ HostWorkers: class {} }));
vi.mock("./manifest.js", () => ({
  backendServices: vi.fn(() => []),
  buildEnvironment: vi.fn(() => ({ BUILD_TIME: "2026-09-11T20:00:00.000Z", GIT_COMMIT: "local-test" })),
  dockerWorker: vi.fn(),
  modelScanner: vi.fn(),
  providerEnv: vi.fn(() => ({})),
  readAssetManifest: vi.fn(async () => ({
    version: "0.1.0", buildTime: "2026-09-11T20:00:00.000Z", digest: "a".repeat(64), versions: {},
  })),
  storageConnection: vi.fn(() => "test-storage"),
  targetIds: [],
}));
vi.mock("./paths.js", () => ({
  acquireLock: vi.fn(async () => mocks.release),
  isMissing: vi.fn(() => false),
  preparePaths: vi.fn(async () => {}),
  readPorts: vi.fn(async () => ({})),
  serverPaths: vi.fn(() => mocks.paths),
  writeJson: vi.fn(async () => {}),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.argv = [process.execPath, "scope-server", "start", "--non-interactive"];
  vi.stubEnv("DOCKER_HOST", `unix://${mocks.paths.runtime}/docker.sock`);
  vi.stubEnv("DOCKER_CONTEXT", undefined);
  vi.stubEnv("npm_config_registry", "https://registry.example.test/");
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("launcher signal cleanup", () => {
  it("releases the launcher without querying an engine that never connected", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("Engine probe timed out"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("./cli.js");
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Engine probe timed out"));
    expect(mocks.agentClose).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.removeRuntime).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("retains both signal handlers through deferred cleanup and tolerates repeated signals", async () => {
    let finishAgents: () => void = () => {};
    let finishRelease: () => void = () => {};
    mocks.agentClose.mockReturnValue(new Promise<void>(resolve => { finishAgents = resolve; }));
    mocks.release.mockReturnValue(new Promise<void>(resolve => { finishRelease = resolve; }));
    const registered = vi.spyOn(process, "on");
    const removed = vi.spyOn(process, "off");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let interrupt: (() => void) | undefined;
    let terminate: (() => void) | undefined;

    try {
      await import("./cli.js");
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("Scope Server is ready.")));
      interrupt = registered.mock.calls.find(([event]) => event === "SIGINT")?.[1];
      terminate = registered.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      if (!interrupt || !terminate) throw new Error("Launcher did not register both signal handlers");
      const expectHandlersRegistered = (): void => {
        expect(process.listeners("SIGINT")).toContain(interrupt);
        expect(process.listeners("SIGTERM")).toContain(terminate);
        expect(removed).not.toHaveBeenCalledWith("SIGINT", interrupt);
        expect(removed).not.toHaveBeenCalledWith("SIGTERM", terminate);
      };
      expectHandlersRegistered();
      mocks.stop.mockClear(); // Startup already removed stale owned containers.

      interrupt();
      await vi.waitFor(() => expect(mocks.agentClose).toHaveBeenCalledOnce());
      expectHandlersRegistered();
      expect(() => interrupt?.()).not.toThrow();
      expect(() => terminate?.()).not.toThrow();
      expect(mocks.cancel).toHaveBeenCalledTimes(3);
      expect(mocks.agentClose).toHaveBeenCalledOnce();
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.controlClose).not.toHaveBeenCalled();
      expect(mocks.release).not.toHaveBeenCalled();

      finishAgents();
      await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledOnce());
      expectHandlersRegistered();
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.controlClose).toHaveBeenCalledOnce();
      expect(mocks.removeRuntime).toHaveBeenCalledWith(`${mocks.paths.runtime}/server.json`, { force: true });
      expect(() => interrupt?.()).not.toThrow();
      expect(mocks.release).toHaveBeenCalledOnce();

      finishRelease();
      await vi.waitFor(() => {
        expect(process.listeners("SIGINT")).not.toContain(interrupt);
        expect(process.listeners("SIGTERM")).not.toContain(terminate);
      });
      expect(removed).toHaveBeenCalledWith("SIGINT", interrupt);
      expect(removed).toHaveBeenCalledWith("SIGTERM", terminate);
      expect(mocks.agentClose).toHaveBeenCalledOnce();
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(mocks.controlClose).toHaveBeenCalledOnce();
      expect(mocks.release).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(originalExitCode);
    } finally {
      finishAgents();
      finishRelease();
      interrupt?.();
      for (const [event, listener] of registered.mock.calls) {
        if (event === "SIGINT" || event === "SIGTERM") process.off(event, listener);
      }
    }
  });
});
