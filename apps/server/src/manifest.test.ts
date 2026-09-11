// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { backendServices, dockerWorker, modelScanner, storageConnection, targetIds, type StackOptions } from "./manifest.js";
import { startupOrder } from "docker-orchestrator";

const options: StackOptions = {
  source: "/package/assets/source",
  data: "/home/person/.local/share/scope-server",
  manifest: {
    version: "0.1.0", digest: "a".repeat(64),
    versions: { COPILOT_CLI_VERSION: "1.0.65", CLAUDE_CODE_ACP_VERSION: "0.52.0", CLAUDE_AGENT_SDK_VERSION: "0.3.191" },
  },
  registry: "https://registry.example.test/",
  controlUrl: "http://host.docker.internal:40000/",
  env: {},
};

describe("packaged backend", () => {
  it("starts the actual backend and Portal with migrations and no coding-agent image builds", () => {
    const services = backendServices(options);
    expect(startupOrder(services)).toHaveLength(services.length);
    expect(services.map(item => item.name)).toEqual(expect.arrayContaining([
      "mongodb", "redis", "azurite", "db-migrate", "storage-init", "api",
      "judge", "scheduler", "token-manager", "portal", "post-processor", "report-generator",
    ]));
    expect(services.some(item => targetIds.includes(item.name as typeof targetIds[number]))).toBe(false);
    const migration = services.find(item => item.name === "db-migrate")!;
    expect(migration.kind).toBe("job");
    expect(migration.image.build?.dockerfile).toBe("packages/db-migrations/Dockerfile.scope");
    expect(services.find(item => item.name === "api")?.dependsOn).toContain("db-migrate");
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
