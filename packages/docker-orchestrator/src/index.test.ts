// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";
import { PassThrough, type Readable } from "node:stream";
import { createServer } from "node:http";
import { containerOptions, Docker as DockerClient, Orchestrator, startupOrder, type Service } from "./index.js";

const service = (name: string, extra: Partial<Service> = {}): Service => ({
  name, image: { name: "redis:7.4.2-alpine" }, memoryMb: 128, ...extra,
});
const missing = () => Object.assign(new Error("Not found"), { statusCode: 404 });

describe("small service/job DSL", () => {
  it("sorts dependencies before services, including one-shot jobs", () => {
    expect(startupOrder([
      service("api", { dependsOn: ["migrate"] }),
      service("migrate", { kind: "job", dependsOn: ["db"] }),
      service("db"),
    ]).map(item => item.name)).toEqual(["db", "migrate", "api"]);
  });

  it("rejects invalid plans before starting Docker resources", () => {
    expect(() => startupOrder([service("api", { dependsOn: ["missing"] })])).toThrow("Missing");
    expect(() => startupOrder([service("api"), service("api")])).toThrow("Duplicate");
    expect(() => startupOrder([service("api", { dependsOn: ["api"] })])).toThrow("cycle");
    expect(() => startupOrder([service("api", { memoryMb: 0 })])).toThrow("memory");
  });

  it("publishes only loopback ports and binds persistent paths without implicit volumes", () => {
    const options = containerOptions(service("db", {
      ports: [{ container: 27017 }, { container: 80, host: 43127 }],
      mounts: [{ source: "/home/person/data/db", target: "/data/db" }],
      env: { DATABASE: "scope" },
    }), "scope-user", "scope-user-network");
    expect(options.HostConfig?.PortBindings).toEqual({
      "27017/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
      "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "43127" }],
    });
    expect(options.HostConfig?.Memory).toBe(128 * 1024 * 1024);
    expect(options.HostConfig?.Mounts).toEqual([{ Type: "bind", Source: "/home/person/data/db", Target: "/data/db", ReadOnly: false }]);
    expect(options.Env).toEqual(["DATABASE=scope"]);
    expect(options.HostConfig?.RestartPolicy).toEqual({ Name: "no" });
    expect(options.HostConfig?.ExtraHosts).toBeUndefined();
  });

  it("does not pull a cached image and waits for a migration's exit status", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const inspect = vi.fn().mockResolvedValue({ State: { Status: "exited", ExitCode: 0 } });
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({}) })),
      getContainer: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(missing()) })),
      createContainer: vi.fn().mockResolvedValue({ start, inspect }),
      pull: vi.fn(),
    };
    const orchestrator = new Orchestrator(docker as unknown as Docker, "scope-user");
    await orchestrator.start([service("migrate", { kind: "job" })]);
    expect(start).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledOnce();
    expect(docker.pull).not.toHaveBeenCalled();
  });

  it("retries a temporarily unavailable local engine before inspecting owned resources", async () => {
    const docker = {
      ping: vi.fn().mockRejectedValueOnce(Object.assign(new Error("Engine warming up"), { code: "ECONNREFUSED" }))
        .mockResolvedValue(undefined),
      getNetwork: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ Labels: { "dev.scope.server.owner": "scope-user" } }),
      })),
    };
    await new Orchestrator(docker as unknown as Docker, "scope-user").connect();
    expect(docker.ping).toHaveBeenCalledTimes(2);
    expect(docker.getNetwork).toHaveBeenCalledOnce();
  });

  it("aborts a nonresponding engine probe instead of hanging startup", async () => {
    vi.useFakeTimers();
    try {
      const docker = {
        ping: vi.fn(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
          abortSignal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        })),
        getNetwork: vi.fn(),
      };
      const result = expect(new Orchestrator(docker as unknown as Docker, "scope-user").connect())
        .rejects.toThrow("did not respond within 15 seconds");
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      expect(docker.ping).toHaveBeenCalledOnce();
      expect(docker.getNetwork).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("cancels an in-flight engine probe without waiting for its timeout", async () => {
    const docker = {
      ping: vi.fn(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
        abortSignal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      })),
      getNetwork: vi.fn(),
    };
    const orchestrator = new Orchestrator(docker as unknown as Docker, "scope-user");
    const result = expect(orchestrator.connect()).rejects.toThrow("Scope startup cancelled");
    orchestrator.cancel();
    await result;
    expect(docker.getNetwork).not.toHaveBeenCalled();
  });

  it("reports real failed-job output and does not start dependents", async () => {
    const container = {
      start: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ State: { Status: "exited", ExitCode: 1 } }),
      logs: vi.fn().mockResolvedValue(Buffer.from("migration failed")),
    };
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({}) })),
      getContainer: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(missing()) })),
      createContainer: vi.fn().mockResolvedValue(container),
    };
    const orchestrator = new Orchestrator(docker as unknown as Docker, "scope-user");
    await expect(orchestrator.start([
      service("api", { dependsOn: ["migrate"] }), service("migrate", { kind: "job" }),
    ])).rejects.toThrow("migration failed");
    expect(docker.createContainer).toHaveBeenCalledOnce();
  });

  it("fails on an engine build-error event even when the progress stream closes normally", async () => {
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(missing()) })),
      buildImage: vi.fn(async (context: Readable) => {
        for await (const chunk of context) expect(Buffer.isBuffer(chunk)).toBe(true);
        return new PassThrough();
      }),
      createContainer: vi.fn(),
      modem: {
        followProgress: (_stream: NodeJS.ReadableStream, done: (error: Error | null) => void, progress: (event: unknown) => void) => {
          progress({ errorDetail: { message: "Registry bootstrap failed" } });
          done(null);
        },
      },
    };
    const orchestrator = new Orchestrator(docker as unknown as Docker, "scope-user");
    await expect(orchestrator.startService(service("migrate", {
      image: { name: "scope-local/migrate:test", build: { context: import.meta.dirname, dockerfile: "Dockerfile" } },
    }))).rejects.toThrow("Registry bootstrap failed");
    expect(docker.buildImage).toHaveBeenCalledOnce();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("explains gateway build disk exhaustion instead of surfacing raw ENOSPC", async () => {
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(missing()) })),
      buildImage: vi.fn(async (context: Readable) => {
        for await (const chunk of context) expect(Buffer.isBuffer(chunk)).toBe(true);
        return new PassThrough();
      }),
      createContainer: vi.fn(),
      modem: {
        followProgress: (_stream: NodeJS.ReadableStream, done: (error: Error | null) => void, progress: (event: unknown) => void) => {
          progress({ errorDetail: { message: "ENOSPC: no space left on device" } });
          done(null);
        },
      },
    };
    const orchestrator = new Orchestrator(docker as unknown as Docker, "scope-user");
    await expect(orchestrator.startService(service("gateway", {
      image: { name: "scope-local/gateway:test", build: { context: import.meta.dirname, dockerfile: "Dockerfile" } },
    }))).rejects.toThrow("Free Docker engine storage");
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("recreates the source stream when retrying an interrupted build", async () => {
    const contexts: Readable[] = [];
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(missing()) })),
      getContainer: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(missing()) })),
      createContainer: vi.fn().mockResolvedValue({
        start: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({ State: { Status: "exited", ExitCode: 0 } }),
      }),
      buildImage: vi.fn(async (context: Readable) => {
        contexts.push(context);
        let size = 0;
        for await (const chunk of context) {
          const bytes: Buffer = chunk;
          size += bytes.length;
        }
        expect(size).toBeGreaterThan(0);
        return new PassThrough();
      }),
      modem: {
        followProgress: vi.fn()
          .mockImplementationOnce((_stream: Readable, done: (error: Error) => void) =>
            done(Object.assign(new Error("aborted"), { code: "ECONNRESET" })))
          .mockImplementationOnce((_stream: Readable, done: (error: null) => void) => done(null)),
      },
    };
    await new Orchestrator(docker as unknown as Docker, "scope-user").startService(service("migrate", {
      kind: "job",
      image: { name: "scope-local/migrate:test", build: { context: import.meta.dirname, dockerfile: "Dockerfile" } },
    }));
    expect(docker.buildImage).toHaveBeenCalledTimes(2);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(docker.createContainer).toHaveBeenCalledOnce();
  });

  it("lets an image build stay silent longer than the management-request timeout", async () => {
    let completedBuild = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((request, response) => {
      request.resume();
      if (request.url?.startsWith("/build?")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write(`${JSON.stringify({ stream: "Committing a large layer" })}\n`);
        timer = setTimeout(() => {
          completedBuild = true;
          response.end(`${JSON.stringify({ stream: "Successfully built" })}\n`);
        }, 250);
      } else if (request.url?.startsWith("/containers/create")) {
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ Id: "job" }));
      } else if (request.url === "/containers/job/start") {
        response.writeHead(204);
        response.end();
      } else if (request.url === "/containers/job/json") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ State: { Status: "exited", ExitCode: 0 } }));
      } else {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ message: "Not found" }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const docker = new DockerClient({ host: "127.0.0.1", port: address.port, protocol: "http", timeout: 50 });
      await new Orchestrator(docker, "scope-user").startService(service("job", {
        kind: "job",
        image: { name: "scope-local/job:test", build: { context: import.meta.dirname, dockerfile: "Dockerfile" } },
      }));
      expect(completedBuild).toBe(true);
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("refuses to replace a container it does not own", async () => {
    const remove = vi.fn();
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({}) })),
      getContainer: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ Config: { Labels: {} }, State: { Running: true } }),
        remove,
      })),
      createContainer: vi.fn(),
    };
    await expect(new Orchestrator(docker as unknown as Docker, "scope-user").startService(service("api"))).rejects.toThrow("unowned");
    expect(remove).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("reclaims stale owned containers without touching the network or reporting a stop", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const networkRemove = vi.fn();
    const docker = {
      listContainers: vi.fn().mockResolvedValue([
        { Labels: { "dev.scope.server.service": "api" } },
        { Labels: { "dev.scope.server.service": "portal" } },
      ]),
      getContainer: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({
          Config: { Labels: { "dev.scope.server.owner": "scope-user" } },
          State: { Running: false },
        }),
        remove,
      })),
      getNetwork: vi.fn(() => ({ inspect: vi.fn(), remove: networkRemove })),
    };
    const phases: string[] = [];
    const orchestrator = new Orchestrator(
      docker as unknown as Docker, "scope-user", event => phases.push(`${event.service}:${event.phase}`),
    );

    await orchestrator.reclaim();

    // Both leftovers go, reported as reclaimed — never as "stopping", which
    // directly after `start` reads like the platform is shutting down.
    expect(remove).toHaveBeenCalledTimes(2);
    expect(phases).toEqual(["portal:reclaimed", "api:reclaimed"]);
    expect(phases.some(p => p.includes("stopping"))).toBe(false);
    // The network the caller just created must survive.
    expect(networkRemove).not.toHaveBeenCalled();
  });

  it("stays silent when there is nothing to reclaim", async () => {
    const docker = {
      listContainers: vi.fn().mockResolvedValue([]),
      getContainer: vi.fn(),
      getNetwork: vi.fn(),
    };
    const phases: string[] = [];
    await new Orchestrator(
      docker as unknown as Docker, "scope-user", event => phases.push(event.phase),
    ).reclaim();
    expect(phases).toEqual([]);
  });

  it("bounds graceful shutdown and force-removes only the inspected owned container", async () => {
    vi.useFakeTimers();
    try {
      const remove = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
        abortSignal.addEventListener("abort", () => reject(new Error("Stop request aborted")), { once: true });
      }));
      const progress = vi.fn();
      const docker = { getContainer: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ Config: { Labels: { "dev.scope.server.owner": "scope-user" } }, State: { Running: true } }),
        stop, remove,
      })) };
      const result = new Orchestrator(docker as unknown as Docker, "scope-user", progress).stopService("api");
      await vi.advanceTimersByTimeAsync(29_999);
      expect(remove).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(stop).toHaveBeenCalledWith({ t: 20, abortSignal: expect.any(AbortSignal) });
      expect(remove).toHaveBeenCalledExactlyOnceWith({ force: true });
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("forcing removal of owned container") }));
    } finally { vi.useRealTimers(); }
  });

  it.each([304, 404])("handles an already-stopped or removed container (%s) without forcing removal", async statusCode => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const docker = { getContainer: vi.fn(() => ({
      inspect: vi.fn().mockResolvedValue({ Config: { Labels: { "dev.scope.server.owner": "scope-user" } }, State: { Running: true } }),
      stop: vi.fn().mockRejectedValue(Object.assign(new Error("Concurrent stop"), { statusCode })),
      remove,
    })) };
    await new Orchestrator(docker as unknown as Docker, "scope-user").stopService("api");
    if (statusCode === 304) expect(remove).toHaveBeenCalledExactlyOnceWith();
    else expect(remove).not.toHaveBeenCalled();
  });

  it("retains graceful-stop and forced-removal errors when cleanup cannot finish", async () => {
    const stopError = new Error("Stop failed");
    const removeError = new Error("Remove failed");
    const docker = { getContainer: vi.fn(() => ({
      inspect: vi.fn().mockResolvedValue({ Config: { Labels: { "dev.scope.server.owner": "scope-user" } }, State: { Running: true } }),
      stop: vi.fn().mockRejectedValue(stopError),
      remove: vi.fn().mockRejectedValue(removeError),
    })) };
    await expect(new Orchestrator(docker as unknown as Docker, "scope-user").stopService("api"))
      .rejects.toMatchObject({ errors: [stopError, removeError] });
  });

  it.each(["pending", "transfer", "backoff"])("does not retry an image pull cancelled during %s", async phase => {
    const stream = new PassThrough();
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(missing()) })),
      pull: vi.fn(async () => {
        if (phase === "pending") orchestrator.cancel();
        if (phase === "backoff") throw new Error("Temporary registry failure");
        return stream;
      }),
      createContainer: vi.fn(),
      modem: {
        followProgress: (input: Readable, done: (error: Error) => void) => {
          input.on("error", done);
          if (phase === "transfer") orchestrator.cancel();
        },
      },
    };
    const orchestrator = new Orchestrator(docker as unknown as Docker, "scope-user");
    const result = expect(orchestrator.startService(service("db"))).rejects.toThrow("Scope startup cancelled");
    if (phase === "backoff") {
      await vi.waitFor(() => expect(docker.pull).toHaveBeenCalledOnce());
      orchestrator.cancel();
    }
    await result;
    expect(docker.pull).toHaveBeenCalledOnce();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("does not treat a running worker as ready until its queue/database startup log appears", async () => {
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({}) })),
      getContainer: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(missing()) })),
      createContainer: vi.fn().mockResolvedValue({
        start: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
        logs: vi.fn().mockResolvedValue(Buffer.from("[worker] Connected to MongoDB")),
      }),
    };
    await new Orchestrator(docker as unknown as Docker, "scope-user").startService(service("worker", { readyLog: "[worker] Connected to MongoDB" }));
    expect(docker.createContainer).toHaveBeenCalledOnce();
  });

  it("reads a completed job's stdout through Docker's demultiplexer", async () => {
    const logs = vi.fn().mockResolvedValue(Buffer.from("model metadata"));
    const demuxStream = vi.fn((input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => input.pipe(output));
    const docker = {
      getImage: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({}) })),
      getContainer: vi.fn(() => ({ inspect: vi.fn().mockRejectedValue(missing()) })),
      createContainer: vi.fn().mockResolvedValue({
        start: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({ State: { Status: "exited", ExitCode: 0 } }),
        logs,
      }),
      modem: { demuxStream },
    };
    const orchestrator = new Orchestrator(docker as unknown as Docker, "scope-user");
    await orchestrator.startService(service("scanner", { kind: "job" }));
    expect(await orchestrator.output("scanner")).toBe("model metadata");
    expect(logs).toHaveBeenCalledWith({ stdout: true, stderr: false, follow: false });
    expect(demuxStream).toHaveBeenCalledOnce();
  });
});
