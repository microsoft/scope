// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import Docker from "dockerode";
import { setTimeout as sleep } from "node:timers/promises";
import { PassThrough, Readable } from "node:stream";
import { isIP } from "node:net";
import { create as tar } from "tar";

export interface Image {
  name: string;
  build?: {
    context: string;
    dockerfile: string;
    target?: string;
    args?: Record<string, string>;
  };
}

export interface Service {
  name: string;
  image: Image;
  kind?: "service" | "job";
  dependsOn?: string[];
  env?: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  workingDir?: string;
  user?: string;
  memoryMb: number;
  mounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
  ports?: Array<{ container: number; host?: number }>;
  healthcheck?: string[];
  readyLog?: string;
  readinessTimeoutMs?: number;
  restart?: boolean;
}

export interface Progress {
  service: string;
  phase: "image" | "starting" | "ready" | "stopping";
  message?: string;
}

const label = "dev.scope.server.owner";

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null &&
    "statusCode" in error && error.statusCode === status;
}

function isTransportError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" &&
    ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error.code);
}

export function startupOrder(services: readonly Service[]): Service[] {
  const byName = new Map(services.map(service => [service.name, service]));
  if (byName.size !== services.length) throw new Error("Duplicate service name");
  const result: Service[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Dependency cycle at ${name}`);
    const service = byName.get(name);
    if (!service) throw new Error(`Missing service dependency: ${name}`);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid service name: ${name}`);
    if (!Number.isFinite(service.memoryMb) || service.memoryMb <= 0) {
      throw new Error(`Invalid memory limit for ${name}`);
    }
    visiting.add(name);
    for (const dependency of service.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    result.push(service);
  }
  for (const service of services) visit(service.name);
  return result;
}

export function containerOptions(service: Service, owner: string, network: string): Docker.ContainerCreateOptions {
  const ports = service.ports ?? [];
  return {
    name: `${owner}-${service.name}`,
    Image: service.image.name,
    Labels: { [label]: owner, "dev.scope.server.service": service.name },
    Env: Object.entries(service.env ?? {}).map(([key, value]) => `${key}=${value}`),
    Cmd: service.command,
    Entrypoint: service.entrypoint,
    WorkingDir: service.workingDir,
    User: service.user,
    ExposedPorts: Object.fromEntries(ports.map(port => [`${port.container}/tcp`, {}])),
    Healthcheck: service.healthcheck ? {
      Test: ["CMD", ...service.healthcheck],
      Interval: 2_000_000_000,
      Timeout: 5_000_000_000,
      Retries: 30,
      StartPeriod: 5_000_000_000,
    } : undefined,
    HostConfig: {
      Memory: service.memoryMb * 1024 * 1024,
      NetworkMode: network,
      RestartPolicy: { Name: service.restart ? "unless-stopped" : "no" },
      Mounts: service.mounts?.map(mount => ({
        Type: "bind",
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.readOnly ?? false,
      })),
      PortBindings: Object.fromEntries(ports.map(port => [
        `${port.container}/tcp`,
        [{ HostIp: "127.0.0.1", HostPort: String(port.host ?? 0) }],
      ])),
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
    NetworkingConfig: {
      EndpointsConfig: { [network]: { Aliases: [service.name] } },
    },
  };
}

/** Deliberately limited to this launcher's named services, jobs and Docker labels. */
export class Orchestrator {
  private readonly containers = new Map<string, Docker.Container>();
  private readonly preparedImages = new Set<string>();
  private readonly network: string;
  private cancelled = false;
  private cancelTransfer: (() => void) | undefined;

  constructor(
    private readonly docker: Docker,
    private readonly owner: string,
    private readonly progress: (event: Progress) => void = () => {},
  ) {
    this.network = `${owner}-network`;
  }

  async connect(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      this.checkCancelled();
      try {
        await this.docker.ping();
        break;
      } catch (error) {
        if (attempt === 2 || !isTransportError(error)) throw error;
        this.progress({ service: "docker", phase: "starting", message: "Retrying the local engine connection" });
        await sleep(500 * 2 ** attempt);
      }
    }
    this.checkCancelled();
    try {
      const network = await this.docker.getNetwork(this.network).inspect();
      if (network.Labels?.[label] !== this.owner) {
        throw new Error(`Refusing to use unowned network ${this.network}`);
      }
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
      await this.docker.createNetwork({ Name: this.network, Driver: "bridge", Labels: { [label]: this.owner } });
    }
  }

  async bridgeGateway(): Promise<string | undefined> {
    const network = await this.docker.getNetwork(this.network).inspect();
    return network.IPAM?.Config?.find(config => typeof config.Gateway === "string" && isIP(config.Gateway) === 4)?.Gateway;
  }

  async start(services: readonly Service[]): Promise<void> {
    for (const service of startupOrder(services)) await this.startService(service);
  }

  async startService(service: Service): Promise<void> {
    this.checkCancelled();
    await this.ensureImage(service);
    this.checkCancelled();
    await this.removeOwned(service.name);
    this.checkCancelled();
    this.progress({ service: service.name, phase: "starting" });
    const container = await this.docker.createContainer(containerOptions(service, this.owner, this.network));
    this.containers.set(service.name, container);
    this.checkCancelled();
    await container.start();
    await this.waitReady(service, container);
    this.progress({ service: service.name, phase: "ready" });
  }

  private async ensureImage(service: Service): Promise<void> {
    const image = service.image;
    if (this.preparedImages.has(image.name)) return;
    try {
      await this.docker.getImage(image.name).inspect();
      this.preparedImages.add(image.name);
      return;
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
    this.checkCancelled();
    this.progress({ service: service.name, phase: "image", message: image.name });
    if (image.build) {
      // Replaying the same immutable build is safe after a transport failure;
      // compiler/recipe failures are not retried.
      for (let attempt = 0; ; attempt++) {
        this.checkCancelled();
        try {
          // Never send cwd, home or credentials as a build context.
          const context = Readable.from(tar({ cwd: image.build.context, portable: true }, ["."]));
          const stream = await this.docker.buildImage(context, {
            t: image.name,
            dockerfile: image.build.dockerfile,
            target: image.build.target,
            buildargs: image.build.args,
            rm: true,
          });
          await this.follow(stream, service.name);
          break;
        } catch (error) {
          this.checkCancelled();
          if (attempt === 1 || !isTransportError(error)) {
            throw new Error(`Image build for ${service.name} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
          this.progress({ service: service.name, phase: "image", message: "Docker transport interrupted; retrying the build from cached layers" });
          await sleep(1000);
        }
      }
    } else {
      // Pulls are idempotent; retry transient transport/registry failures, not auth/not-found.
      for (let attempt = 0; ; attempt++) {
        this.checkCancelled();
        try {
          const stream = await this.docker.pull(image.name);
          await this.follow(stream, service.name);
          break;
        } catch (error) {
          this.checkCancelled();
          if (attempt === 2 || hasStatus(error, 401) || hasStatus(error, 403) || hasStatus(error, 404)) throw error;
          await sleep(500 * 2 ** attempt);
        }
      }
    }
    this.preparedImages.add(image.name);
  }

  private follow(stream: NodeJS.ReadableStream, service: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let progressError: Error | undefined;
      const cancel = (): void => { (stream as Readable).destroy(new Error("Scope startup cancelled")); };
      this.cancelTransfer = cancel;
      this.docker.modem.followProgress(stream, (error: Error | null) => {
        if (this.cancelTransfer === cancel) this.cancelTransfer = undefined;
        if (error || progressError) reject(progressError ?? error); else resolve();
      }, (event: unknown) => {
        if (typeof event !== "object" || event === null) return;
        if ("error" in event && typeof event.error === "string") {
          progressError = new Error(event.error);
        } else if ("errorDetail" in event && typeof event.errorDetail === "object"
          && event.errorDetail !== null && "message" in event.errorDetail
          && typeof event.errorDetail.message === "string") {
          progressError = new Error(event.errorDetail.message);
        }
        const message = "stream" in event ? event.stream : "status" in event ? event.status : undefined;
        if (typeof message === "string") this.progress({ service, phase: "image", message: message.trim() });
      });
      if (this.cancelled) cancel();
    });
  }

  private async waitReady(service: Service, container: Docker.Container): Promise<void> {
    const deadline = Date.now() + (service.readinessTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      this.checkCancelled();
      const { State: state } = await container.inspect();
      if (service.kind === "job") {
        if (state.Status === "exited") {
          if (state.ExitCode === 0) return;
          throw await this.failure(service.name, container, `exited with ${state.ExitCode}`);
        }
      } else {
        if (!state.Running) throw await this.failure(service.name, container, state.Error || `exited with ${state.ExitCode}`);
        if (service.readyLog) {
          const logs = await container.logs({ stdout: true, stderr: true, tail: 100 });
          if (logs.toString().includes(service.readyLog)) return;
        }
        if (state.Health?.Status === "healthy") return;
        if (!service.healthcheck && !state.Health && !service.readyLog) return;
        if (state.Health?.Status === "unhealthy") throw await this.failure(service.name, container, "unhealthy");
      }
      await sleep(500);
    }
    throw await this.failure(service.name, container, "readiness timed out");
  }

  private async failure(name: string, container: Docker.Container, reason: string): Promise<Error> {
    const output = await container.logs({ stdout: true, stderr: true, tail: 30 }).catch(() => Buffer.from(""));
    return new Error(`${name}: ${reason}\n${output.toString()}`);
  }

  async hostPort(service: string, port: number): Promise<number> {
    const container = this.containers.get(service);
    if (!container) throw new Error(`Service not started: ${service}`);
    const info = await container.inspect();
    const binding = info.NetworkSettings.Ports[`${port}/tcp`]?.[0];
    if (!binding) throw new Error(`Port ${port} is not published by ${service}`);
    return Number(binding.HostPort);
  }

  async output(service: string): Promise<string> {
    const container = this.containers.get(service);
    if (!container) throw new Error(`Service not started: ${service}`);
    const raw = await container.logs({ stdout: true, stderr: false, follow: false });
    const input = Readable.from([raw]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    stderr.resume();
    this.docker.modem.demuxStream(input, stdout, stderr);
    await new Promise<void>((resolve, reject) => {
      input.once("end", resolve);
      input.once("error", reject);
    });
    return Buffer.concat(chunks).toString("utf8");
  }

  async stopService(name: string): Promise<void> {
    this.progress({ service: name, phase: "stopping" });
    await this.removeOwned(name);
    this.containers.delete(name);
  }

  cancel(): void {
    this.cancelled = true;
    this.cancelTransfer?.();
  }

  private checkCancelled(): void {
    if (this.cancelled) throw new Error("Scope startup cancelled");
  }

  private async removeOwned(name: string): Promise<void> {
    const container = this.docker.getContainer(`${this.owner}-${name}`);
    try {
      const info = await container.inspect();
      if (info.Config.Labels?.[label] !== this.owner) throw new Error(`Refusing to remove unowned container ${name}`);
      if (info.State.Running) await container.stop({ t: 20 });
      await container.remove();
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    // Also collect containers left by an interrupted launcher, but never other users' services.
    const owned = await this.docker.listContainers({ all: true, filters: { label: [`${label}=${this.owner}`] } });
    const names = [...new Set([...this.containers.keys(), ...owned.map(container =>
      container.Labels["dev.scope.server.service"]).filter((name): name is string => Boolean(name))])];
    for (const name of names.reverse()) {
      try { await this.stopService(name); } catch (error) { errors.push(error); }
    }
    try {
      const network = await this.docker.getNetwork(this.network).inspect();
      if (network.Labels?.[label] === this.owner) await this.docker.getNetwork(this.network).remove();
    } catch (error) {
      if (!hasStatus(error, 404)) errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Some Scope resources could not be stopped");
  }
}

export { default as Docker } from "dockerode";
