// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Image, Service } from "docker-orchestrator";

export const targetIds = [
  "coder-acp-copilot", "coder-acp-claude-code",
  "coder-acp-copilot-host", "coder-acp-claude-code-host",
] as const;
export type TargetId = typeof targetIds[number];

export function isTargetId(value: string): value is TargetId {
  return targetIds.some(id => id === value);
}

export interface AssetManifest {
  version: string;
  buildTime: string;
  digest: string;
  versions: Record<string, string>;
}

export async function readAssetManifest(assets: string): Promise<AssetManifest> {
  const value: unknown = JSON.parse(await readFile(join(assets, "manifest.json"), "utf8"));
  if (typeof value !== "object" || value === null || !("version" in value) ||
    typeof value.version !== "string" || !("buildTime" in value) ||
    typeof value.buildTime !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.buildTime) ||
    !Number.isFinite(Date.parse(value.buildTime)) || !("digest" in value) ||
    typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) ||
    !("versions" in value) || typeof value.versions !== "object" || value.versions === null ||
    !Object.values(value.versions).every(version => typeof version === "string")) {
    throw new Error("Invalid bundled server assets. Rebuild/reinstall @scope/server.");
  }
  return value as AssetManifest;
}

export function imageTag(manifest: AssetManifest): string {
  return createHash("sha256").update(JSON.stringify({
    digest: manifest.digest,
    version: manifest.version,
    buildTime: manifest.buildTime,
    versions: Object.entries(manifest.versions).sort(([left], [right]) => left.localeCompare(right)),
  })).digest("hex").slice(0, 16);
}

export function buildEnvironment(manifest: AssetManifest): { BUILD_TIME: string; GIT_COMMIT: string } {
  return {
    BUILD_TIME: manifest.buildTime,
    GIT_COMMIT: `local-${imageTag(manifest).slice(0, 12)}`,
  };
}

// Public emulator key, as shipped by Azurite and docker-compose.yml; not a credential.
const emulatorKey = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
export function storageConnection(host: string, blobPort: number, queuePort: number): string {
  return `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${emulatorKey};BlobEndpoint=http://${host}:${blobPort}/devstoreaccount1;QueueEndpoint=http://${host}:${queuePort}/devstoreaccount1;`;
}

export interface StackOptions {
  source: string;
  data: string;
  manifest: AssetManifest;
  registry: string;
  controlUrl: string;
  apiPort?: number;
  portalPort?: number;
  env?: NodeJS.ProcessEnv;
}

const forwarded = [
  "GITHUB_TOKEN", "GITHUB_MODELS_API_KEY", "ANTHROPIC_API_KEY",
  "AZURE_AI_INFERENCE_ENDPOINT", "AZURE_AI_INFERENCE_API_KEY",
  "LLM_MODEL", "JUDGE_MODEL", "FEEDBACK_MODEL", "REPORT_MODEL",
  "JUDGE_STRATEGY", "JUDGE_MAX_PARALLELISM",
] as const;

export function providerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(forwarded.flatMap(key => env[key] ? [[key, env[key]]] : []));
}

export function commonEnv(): Record<string, string> {
  return {
    MONGO_CONNECTION_STRING: "mongodb://mongodb:27017",
    MONGO_DATABASE: "requests-db",
    MONGO_COLLECTION: "requests",
    REDIS_HOST: "redis",
    REDIS_PORT: "6379",
    REDIS_PASSWORD: "",
    AZURE_STORAGE_ACCOUNT_NAME: "devstoreaccount1",
    STORAGE_CONNECTION_STRING: storageConnection("azurite", 10000, 10001),
    TOKEN_MANAGER_URL: "http://token-manager:80",
    SCOPE_MT_API_URL: "http://api:80",
    JUDGE_SERVICE_URL: "http://judge:80",
    AZURE_STORAGE_QUEUE_REPORT: "report-queue",
    AZURE_STORAGE_QUEUE_POSTPROCESSOR: "post-processor-queue",
  };
}

function httpHealth(port = 80, path = "/health"): string[] {
  return ["node", "-e", `require('http').get('http://127.0.0.1:${port}${path}',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))`];
}

/** Build an immutable local image from the packaged source asset bundle. */
export function applicationImage(name: string, dockerfile: string, options: StackOptions, context = options.source): Image {
  const env = options.env ?? process.env;
  return {
    name: `scope-local/${name}:${imageTag(options.manifest)}`,
    build: {
      context,
      dockerfile: `${dockerfile}.scope`,
      args: {
        NPM_CONFIG_REGISTRY: options.registry,
        ...options.manifest.versions,
        ...buildEnvironment(options.manifest),
        ...Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].flatMap(key =>
          env[key] || env[key.toLowerCase()] ? [[key, env[key] ?? env[key.toLowerCase()]!]] : [])),
      },
    },
  };
}

export function backendServices(options: StackOptions): Service[] {
  const env = { ...commonEnv(), ...providerEnv(options.env ?? process.env), ...buildEnvironment(options.manifest) };
  const image = (name: string, dockerfile = `apps/${name}/Dockerfile`): Image => applicationImage(name, dockerfile, options);
  const mount = (name: string, target: string) => [{ source: join(options.data, name), target }];
  return [
    {
      name: "mongodb", image: { name: "mongo:7.0" }, memoryMb: 768,
      command: ["mongod", "--bind_ip_all", "--quiet"],
      mounts: mount("mongodb", "/data/db"),
      ports: [{ container: 27017 }],
      healthcheck: ["mongosh", "--quiet", "--eval", "db.adminCommand('ping')"],
    },
    {
      name: "redis", image: { name: "redis:7.4.2-alpine" }, memoryMb: 128,
      command: ["redis-server", "--appendonly", "yes"],
      mounts: mount("redis", "/data"), ports: [{ container: 6379 }],
      healthcheck: ["redis-cli", "ping"],
    },
    {
      name: "azurite", image: { name: "mcr.microsoft.com/azure-storage/azurite:3.29.0" }, memoryMb: 512,
      command: ["azurite", "--loose", "--skipApiVersionCheck", "--blobHost", "0.0.0.0",
        "--queueHost", "0.0.0.0", "--tableHost", "0.0.0.0", "--silent", "--location", "/data"],
      mounts: mount("azurite", "/data"),
      ports: [{ container: 10000 }, { container: 10001 }],
      healthcheck: ["node", "-e", "require('http').get('http://localhost:10001',r=>process.exit(r.statusCode===400?0:1)).on('error',()=>process.exit(1))"],
    },
    {
      name: "lowkey-vault", image: { name: "nagyesta/lowkey-vault:7.2.0-ubi10-minimal" }, memoryMb: 512,
      env: { LOWKEY_ARGS: "--server.port=8443 --spring.main.banner-mode=off --LOWKEY_DEBUG_REQUEST_LOG=false --LOWKEY_VAULT_NAMES=- --LOWKEY_IMPORT_LOCATION=/import/export.json --LOWKEY_EXPORT_LOCATION=/import/export.json" },
      mounts: mount("vault", "/import"),
      healthcheck: ["curl", "-fk", "https://localhost:8443/ping"],
    },
    {
      name: "db-migrate", kind: "job", image: image("db-migrate", "packages/db-migrations/Dockerfile"),
      memoryMb: 512, dependsOn: ["mongodb"], env,
      readinessTimeoutMs: 300_000,
    },
    {
      name: "storage-init", kind: "job", image: image("api"), memoryMb: 256,
      dependsOn: ["azurite"], env,
      workingDir: "/app/packages/shared",
      entrypoint: ["node"],
      command: ["-e", `const {BlobServiceClient}=require('@azure/storage-blob');const {QueueServiceClient}=require('@azure/storage-queue');(async()=>{const c=process.env.STORAGE_CONNECTION_STRING;const b=BlobServiceClient.fromConnectionString(c);for(const n of ['snapshots','logs','har'])await b.getContainerClient(n).createIfNotExists();const q=QueueServiceClient.fromConnectionString(c);for(const n of ${JSON.stringify([...targetIds.map(id => `queue-${id}`), "report-queue", "post-processor-queue"])})await q.getQueueClient(n).createIfNotExists()})().catch(e=>{console.error(e);process.exit(1)})`],
    },
    {
      name: "token-manager", image: image("token-manager"), memoryMb: 512,
      dependsOn: ["mongodb", "lowkey-vault"], ports: [{ container: 80 }],
      env: {
        ...env, PORT: "80", AZURE_KEYVAULT_URI: "https://lowkey-vault:8443",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        IDENTITY_ENDPOINT: "http://lowkey-vault:8080/metadata/identity/oauth2/token",
        IDENTITY_HEADER: "header", AZURE_POD_IDENTITY_AUTHORITY_HOST: "http://lowkey-vault:8080",
      },
      healthcheck: httpHealth(),
    },
    {
      name: "gateway",
      image: applicationImage("gateway", "Dockerfile", options, join(options.source, "apps/gateway")),
      memoryMb: 512,
      dependsOn: ["storage-init", "redis", "token-manager"],
      ports: [{ container: 18000 }],
      env: {
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
      },
      mounts: mount("gateway-cert", "/certs"),
      command: ["--config", "/config/default.yaml", "--cert-dir", "/certs"],
      healthcheck: ["wget", "-qO-", "http://127.0.0.1:18000/health"],
    },
    {
      name: "api", image: image("api"), memoryMb: 768,
      dependsOn: ["db-migrate", "storage-init", "redis", "token-manager"],
      ports: [{ container: 80, host: options.apiPort }],
      env: {
        ...env, PORT: "80", NODE_ENV: "development", SCOPE_AUTH_ENABLED: "false",
        SCOPE_SERVER_CONTROL_URL: options.controlUrl,
      },
      healthcheck: httpHealth(80, "/ready"),
    },
    {
      name: "judge", image: image("judge"), memoryMb: 1024,
      dependsOn: ["api"], ports: [{ container: 80 }],
      env: { ...env, PORT: "80", CRITERIA_API_URL: "http://api:80" },
      healthcheck: httpHealth(),
    },
    {
      name: "scheduler", image: image("scheduler"), memoryMb: 256,
      dependsOn: ["api"],
      env: { ...env, PORT: "8080", SCHEDULER_WORKER_TYPES: targetIds.join(","), SCHEDULER_POLL_INTERVAL_MS: "2000" },
      healthcheck: httpHealth(8080),
    },
    {
      name: "post-processor-register", kind: "job",
      image: image("post-processor", "apps/workers/post-processor/Dockerfile"),
      memoryMb: 256, dependsOn: ["db-migrate"], env,
      command: ["node", "dist/register-version.js"],
    },
    {
      name: "post-processor", image: image("post-processor", "apps/workers/post-processor/Dockerfile"),
      memoryMb: 1024, dependsOn: ["api", "post-processor-register"], env,
    },
    {
      name: "report-generator", image: image("report-generator", "apps/workers/report-generator/Dockerfile"),
      memoryMb: 1024, dependsOn: ["api"], env,
    },
    {
      name: "portal", image: image("portal"), memoryMb: 128,
      dependsOn: ["api"], ports: [{ container: 80, host: options.portalPort }],
      env: { SCOPE_AUTH_ENABLED: "false", ...buildEnvironment(options.manifest) },
      healthcheck: ["wget", "-qO-", "http://127.0.0.1/"],
    },
  ];
}

export function dockerWorker(id: TargetId, options: StackOptions): Service {
  if (id.endsWith("-host")) throw new Error(`Not a Docker target: ${id}`);
  return {
    name: id, image: applicationImage(id, `apps/workers/${id}/Dockerfile`, options),
    memoryMb: 2048,
    readyLog: `[${id}] Connected to MongoDB`,
    restart: true,
    env: {
      ...commonEnv(), ...providerEnv(options.env ?? process.env),
      ...buildEnvironment(options.manifest),
      // Legacy variable names are retained because both proxy clients still use
      // DEV_PROXY_ENABLED/DEV_PROXY_API_URL even when PROXY_BACKEND selects the gateway.
      PROXY_BACKEND: "gateway",
      DEV_PROXY_ENABLED: "true",
      DEV_PROXY_API_URL: "http://gateway:18000",
      ...(id === "coder-acp-copilot" ? { GATEWAY_TOKEN_PLUGIN_ENABLED: "false" } : {}),
      WORKER_NAME: id,
      NPM_CONFIG_REGISTRY: options.registry,
    },
    mounts: [{ source: join(options.data, "workspaces", id), target: "/workspace" }],
  };
}

export function modelScanner(id: TargetId, options: StackOptions): Service {
  if (id.endsWith("-host")) throw new Error("Host targets discover models through their installed ACP client");
  const provider = id === "coder-acp-copilot" ? "copilot" : "anthropic";
  return {
    name: `model-scanner-${provider}`,
    kind: "job",
    image: applicationImage(`model-scanner-${provider}`, `apps/model-scanners/${provider}/Dockerfile`, options),
    memoryMb: 256,
    readinessTimeoutMs: 180_000,
    command: ["node", "--import", "telemetry/register", "dist/index.js", "--dry-run"],
    env: { ...commonEnv(), ...providerEnv(options.env ?? process.env), ...buildEnvironment(options.manifest), API_URL: "http://api:80" },
  };
}
