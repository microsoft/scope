// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  applicationImage, backendServices, buildEnvironment, dockerWorker, imageTag,
  modelScanner, readAssetManifest, storageConnection, targetIds, type AssetManifest, type StackOptions,
} from "./manifest.js";
import { startupOrder } from "docker-orchestrator";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: vi.fn(),
}));

const options: StackOptions = {
  source: "/package/assets/source",
  data: "/home/person/.local/share/scope-server",
  manifest: {
    version: "0.1.0", buildTime: "2026-09-11T20:23:10.773Z", digest: "a".repeat(64),
    versions: { COPILOT_CLI_VERSION: "1.0.65", CLAUDE_CODE_ACP_VERSION: "0.52.0", CLAUDE_AGENT_SDK_VERSION: "0.3.191" },
  },
  registry: "https://registry.example.test/",
  controlUrl: "http://host.docker.internal:40000/",
  env: {},
};

describe("packaged backend", () => {
  it("reads a real build timestamp separately from the package version", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(options.manifest));
    await expect(readAssetManifest("unused")).resolves.toEqual(options.manifest);
    expect(new Date(options.manifest.buildTime).toISOString()).toBe(options.manifest.buildTime);
  });

  it.each([undefined, "0.1.0", "not-a-date", "2026-13-01T00:00:00.000Z"])(
    "rejects missing or invalid packaged build timestamps (%s)",
    async buildTime => {
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ ...options.manifest, buildTime }));
      await expect(readAssetManifest("unused")).rejects.toThrow("Invalid bundled server assets");
    },
  );

  it("uses identical build metadata for every application image and service runtime", () => {
    const metadata = buildEnvironment(options.manifest);
    expect(metadata).toEqual({
      BUILD_TIME: options.manifest.buildTime,
      GIT_COMMIT: `local-${imageTag(options.manifest).slice(0, 12)}`,
    });
    const services = [
      ...backendServices(options),
      dockerWorker("coder-acp-copilot", options),
      dockerWorker("coder-acp-claude-code", options),
      modelScanner("coder-acp-copilot", options),
      modelScanner("coder-acp-claude-code", options),
    ];
    for (const service of services.filter(service => service.image.build)) {
      expect(service.image.name).toMatch(new RegExp(`:${imageTag(options.manifest)}$`));
      expect(service.image.build?.args).toMatchObject(metadata);
      expect(service.env).toMatchObject(metadata);
    }
  });

  it.each([
    { version: "0.2.0" },
    { buildTime: "2026-09-12T00:00:00.000Z" },
    { digest: "b".repeat(64) },
    { versions: { ...options.manifest.versions, COPILOT_CLI_VERSION: "1.0.84-3" } },
  ] satisfies Partial<AssetManifest>[])("invalidates image and commit identity when metadata changes (%j)", change => {
    const manifest = { ...options.manifest, ...change };
    expect(imageTag(manifest)).not.toBe(imageTag(options.manifest));
    expect(buildEnvironment(manifest).GIT_COMMIT).not.toBe(buildEnvironment(options.manifest).GIT_COMMIT);
    expect(applicationImage("api", "apps/api/Dockerfile", { ...options, manifest }).name)
      .not.toBe(applicationImage("api", "apps/api/Dockerfile", options).name);
  });

  it("keeps image identity stable for equivalent component version maps", () => {
    const versions = Object.fromEntries(Object.entries(options.manifest.versions).reverse());
    expect(imageTag({ ...options.manifest, versions })).toBe(imageTag(options.manifest));
  });

  it("starts the actual backend and Portal with migrations and no coding-agent image builds", () => {
    const services = backendServices(options);
    expect(startupOrder(services)).toHaveLength(services.length);
    expect(services.map(item => item.name)).toEqual(expect.arrayContaining([
      "mongodb", "redis", "azurite", "db-migrate", "storage-init", "api",
      "judge", "scheduler", "token-manager", "gateway", "portal", "post-processor", "report-generator",
    ]));
    expect(services.some(item => targetIds.includes(item.name as typeof targetIds[number]))).toBe(false);
    const migration = services.find(item => item.name === "db-migrate")!;
    expect(migration.kind).toBe("job");
    expect(migration.image.build?.dockerfile).toBe("packages/db-migrations/Dockerfile.scope");
    expect(services.find(item => item.name === "api")?.dependsOn).toContain("db-migrate");
  });

  it("runs the gateway as a first-class local service with persistent certs", () => {
    const gateway = backendServices(options).find(item => item.name === "gateway");
    expect(gateway).toBeDefined();
    expect(gateway?.image.name).toBe(`scope-local/gateway:${imageTag(options.manifest)}`);
    expect(gateway?.image.build).toMatchObject({
      context: "/package/assets/source/apps/gateway",
      dockerfile: "Dockerfile.scope",
    });
    expect(gateway?.memoryMb).toBe(512);
    expect(gateway?.ports).toEqual([{ container: 18000 }]);
    expect(gateway?.mounts).toEqual([{ source: "/home/person/.local/share/scope-server/gateway-cert", target: "/certs" }]);
    expect(gateway?.command).toEqual(["--config", "/config/default.yaml", "--cert-dir", "/certs"]);
    expect(gateway?.healthcheck).toEqual(["wget", "-qO-", "http://127.0.0.1:18000/health"]);
    expect(gateway?.dependsOn).toEqual(expect.arrayContaining(["storage-init", "redis", "token-manager"]));
    expect(gateway?.env).toMatchObject({
      RUST_LOG: "debug,gateway::internal=info,azure_core::policies::transport=info",
      AZURE_STORAGE_USE_EMULATOR: "true",
      AZURITE_BLOB_HOST: "azurite",
      AZURITE_BLOB_PORT: "10000",
      BLOB_STORAGE_URL: "http://azurite:10000/devstoreaccount1",
      STORAGE_CONNECTION_STRING: storageConnection("azurite", 10000, 10001),
      REDIS_HOST: "redis",
      REDIS_PORT: "6379",
      REDIS_PASSWORD: "",
      TOKEN_MANAGER_URL: "http://token-manager:80",
      ...buildEnvironment(options.manifest),
    });
  });

  it("uses the genuine Compose infrastructure image versions", () => {
    const images = backendServices(options).filter(item => !item.image.build).map(item => item.image.name);
    expect(images).toEqual([
      "mongo:7.0", "redis:7.4.2-alpine", "mcr.microsoft.com/azure-storage/azurite:3.29.0",
      "nagyesta/lowkey-vault:7.2.0-ubi10-minimal",
    ]);
  });

  it("prepares only the requested Docker worker using the pinned real component versions", () => {
    const worker = dockerWorker("coder-acp-copilot", options);
    expect(worker.image.build?.dockerfile).toBe("apps/workers/coder-acp-copilot/Dockerfile.scope");
    expect(worker.image.build?.args?.COPILOT_CLI_VERSION).toBe("1.0.65");
    expect(worker.image.build?.args?.NPM_CONFIG_REGISTRY).toBe(options.registry);
    expect(worker.env).toMatchObject({
      PROXY_BACKEND: "gateway",
      DEV_PROXY_ENABLED: "true",
      DEV_PROXY_API_URL: "http://gateway:18000",
      GATEWAY_TOKEN_PLUGIN_ENABLED: "false",
    });
    const claudeWorker = dockerWorker("coder-acp-claude-code", options);
    expect(claudeWorker.env).toMatchObject({
      PROXY_BACKEND: "gateway",
      // Claude Code's native CLI cannot reach its API through the gateway, so
      // capture stays off for it rather than breaking the benchmark.
      DEV_PROXY_ENABLED: "",
      DEV_PROXY_API_URL: "http://gateway:18000",
    });
    expect(claudeWorker.env).not.toHaveProperty("GATEWAY_TOKEN_PLUGIN_ENABLED");
    expect(() => dockerWorker("coder-acp-copilot-host", options)).toThrow("Not a Docker target");
  });

  it("keeps scheduler queues distinct and disables only local Portal auth", () => {
    const services = backendServices(options);
    expect(services.find(item => item.name === "scheduler")?.env?.SCHEDULER_WORKER_TYPES).toBe(targetIds.join(","));
    expect(services.find(item => item.name === "portal")?.env?.SCOPE_AUTH_ENABLED).toBe("false");
    expect(services.find(item => item.name === "api")?.env?.SCOPE_SERVER_CONTROL_URL).toBe(options.controlUrl);
    expect(services.find(item => item.name === "api")?.env).not.toHaveProperty("SCOPE_SERVER_CONTROL_TOKEN");
    expect(services.find(item => item.name === "storage-init")?.command?.join(" ")).toContain("queue-coder-acp-copilot-host");
  });

  it("translates host storage connections without using container DNS", () => {
    const connection = storageConnection("127.0.0.1", 41000, 41001);
    expect(connection).toContain("BlobEndpoint=http://127.0.0.1:41000/devstoreaccount1");
    expect(connection).toContain("QueueEndpoint=http://127.0.0.1:41001/devstoreaccount1");
    expect(connection).not.toContain("azurite");
  });

  it("runs the selected Docker provider's existing scanner without its cross-agent writes", () => {
    const scanner = modelScanner("coder-acp-copilot", options);
    expect(scanner.image.build?.dockerfile).toBe("apps/model-scanners/copilot/Dockerfile.scope");
    expect(scanner.kind).toBe("job");
    expect(scanner.command).toContain("--dry-run");
    expect(scanner.env?.TOKEN_MANAGER_URL).toBe("http://token-manager:80");
    expect(() => modelScanner("coder-acp-copilot-host", options)).toThrow("installed ACP");
  });
});
