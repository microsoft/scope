// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Image, Service } from "docker-orchestrator";

export const targetIds = [
  "coder-acp-copilot",
  "coder-acp-claude-code",
  "coder-acp-copilot-host",
  "coder-acp-claude-code-host",
] as const;

/** Worker IDs the packaged server can build or supervise locally. */
export type TargetId = typeof targetIds[number];

/** Narrow user/config input to one of the local server's supported worker targets. */
export function isTargetId(value: string): value is TargetId {
  return targetIds.some(id => id === value);
}

/** Build metadata emitted with the package and folded into immutable image tags. */
export interface AssetManifest {
  version: string;
  buildTime: string;
  digest: string;
  versions: Record<string, string>;
}

/**
 * Read and validate the packaged asset manifest before deriving Docker tags.
 *
 * The manifest is part of the trust boundary between the npx package and Docker
 * builds, so malformed timestamps or digests are rejected before they can create
 * ambiguous local image/cache keys.
 */
export async function readAssetManifest(assets: string): Promise<AssetManifest> {
  const value: unknown = JSON.parse(await readFile(join(assets, "manifest.json"), "utf8"));
  if (
    typeof value !== "object" || value === null ||
    !("version" in value) || typeof value.version !== "string" ||
    !("buildTime" in value) || typeof value.buildTime !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.buildTime) ||
    !Number.isFinite(Date.parse(value.buildTime)) ||
    !("digest" in value) || typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !("versions" in value) || typeof value.versions !== "object" ||
    value.versions === null ||
    !Object.values(value.versions).every(version => typeof version === "string")
  ) {
    throw new Error("Invalid bundled server assets. Rebuild/reinstall @scope/server.");
  }
  return value as AssetManifest;
}

/**
 * Compute the short immutable tag shared by all images from this asset bundle.
 *
 * The source digest and component versions are sorted into the hash so two
 * packages with the same npm version but different build contents cannot collide
 * in a user's local Docker cache.
 */
export function imageTag(manifest: AssetManifest): string {
  return createHash("sha256").update(JSON.stringify({
    digest: manifest.digest,
    version: manifest.version,
    buildTime: manifest.buildTime,
    versions: Object.entries(manifest.versions).sort(([left], [right]) => left.localeCompare(right)),
  })).digest("hex").slice(0, 16);
}

/** Convert manifest metadata into the build/version environment expected by Scope apps. */
export function buildEnvironment(manifest: AssetManifest): { BUILD_TIME: string; GIT_COMMIT: string } {
  return {
    BUILD_TIME: manifest.buildTime,
    GIT_COMMIT: `local-${imageTag(manifest).slice(0, 12)}`,
  };
}

// Public emulator key, as shipped by Azurite and docker-compose.yml; not a credential.
const emulatorKey = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

/** Build an Azurite connection string for containers or host workers. */
export function storageConnection(host: string, blobPort: number, queuePort: number): string {
  return [
    "DefaultEndpointsProtocol=http",
    "AccountName=devstoreaccount1",
    `AccountKey=${emulatorKey}`,
    `BlobEndpoint=http://${host}:${blobPort}/devstoreaccount1`,
    `QueueEndpoint=http://${host}:${queuePort}/devstoreaccount1`,
  ].join(";") + ";";
}

/** Inputs needed to materialize the local Docker stack from packaged assets. */
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

/** Provider/model environment variables safe to forward into local services. */
const forwarded = [
  "GITHUB_TOKEN", "GITHUB_MODELS_API_KEY", "ANTHROPIC_API_KEY",
  "AZURE_AI_INFERENCE_ENDPOINT", "AZURE_AI_INFERENCE_API_KEY",
  "LLM_MODEL", "JUDGE_MODEL", "FEEDBACK_MODEL", "REPORT_MODEL",
  "JUDGE_STRATEGY", "JUDGE_MAX_PARALLELISM",
] as const;

/** Pick only provider credentials and model overrides needed by benchmark services. */
export function providerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(forwarded.flatMap(key => env[key] ? [[key, env[key]]] : []));
}

/** Environment shared by backend containers in the single-host local deployment. */
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
  const script = "require('http')" +
    `.get('http://127.0.0.1:${port}${path}',r=>process.exit(r.statusCode===200?0:1))` +
    ".on('error',()=>process.exit(1))";
  return ["node", "-e", script];
}

/** Build an immutable local image from the packaged source asset bundle. */
export function applicationImage(
  name: string,
  dockerfile: string,
  options: StackOptions,
  context = options.source,
): Image {
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
          env[key] || env[key.toLowerCase()]
            ? [[key, env[key] ?? env[key.toLowerCase()]!]]
            : [])),
      },
    },
  };
}

/**
 * Describe the always-on backend services for a packaged local Scope Server.
 *
 * Persistent service state is bind-mounted under the configured data directory,
 * which is why shutdown can safely replace containers without deleting Mongo,
 * Redis, Azurite, vault, gateway certificate or workspace data.
 */
export function backendServices(options: StackOptions): Service[] {
  const env = {
    ...commonEnv(),
    ...providerEnv(options.env ?? process.env),
    ...buildEnvironment(options.manifest),
  };
  const image = (name: string, dockerfile = `apps/${name}/Dockerfile`): Image =>
    applicationImage(name, dockerfile, options);
  const mount = (name: string, target: string) => [{ source: join(options.data, name), target }];
  const azuriteHealthcheck = "require('http')" +
    ".get('http://localhost:10001',r=>process.exit(r.statusCode===400?0:1))" +
    ".on('error',()=>process.exit(1))";
  const lowkeyArgs = [
    "--server.port=8443",
    "--spring.main.banner-mode=off",
    "--LOWKEY_DEBUG_REQUEST_LOG=false",
    "--LOWKEY_VAULT_NAMES=-",
    "--LOWKEY_IMPORT_LOCATION=/import/export.json",
    "--LOWKEY_EXPORT_LOCATION=/import/export.json",
  ].join(" ");
  const queueNames = [
    ...targetIds.map(id => `queue-${id}`),
    "report-queue",
    "post-processor-queue",
  ];
  const storageInitScript = `
const {BlobServiceClient}=require('@azure/storage-blob');
const {QueueServiceClient}=require('@azure/storage-queue');
(async()=>{
  const c=process.env.STORAGE_CONNECTION_STRING;
  const b=BlobServiceClient.fromConnectionString(c);
  for(const n of ['snapshots','logs','har'])await b.getContainerClient(n).createIfNotExists();
  const q=QueueServiceClient.fromConnectionString(c);
  for(const n of ${JSON.stringify(queueNames)})await q.getQueueClient(n).createIfNotExists();
})().catch(e=>{console.error(e);process.exit(1)});
`.trim();
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
      healthcheck: ["node", "-e", azuriteHealthcheck],
    },
    {
      name: "lowkey-vault", image: { name: "nagyesta/lowkey-vault:7.2.0-ubi10-minimal" }, memoryMb: 512,
      env: { LOWKEY_ARGS: lowkeyArgs },
      mounts: mount("vault", "/import"),
      healthcheck: ["curl", "-fk", "https://localhost:8443/ping"],
    },
    {
      name: "db-migrate", kind: "job", image: image("db-migrate", "packages/db-migrations/Dockerfile"),
      memoryMb: 512, dependsOn: ["mongodb"], env,
      readinessTimeoutMs: 300_000,
    },
    {
      // This one-shot job mirrors the Compose bootstrap and keeps queue/container
      // creation inside Docker so a packaged install needs no Azure CLI.
      name: "storage-init", kind: "job", image: image("api"), memoryMb: 256,
      dependsOn: ["azurite"], env,
      workingDir: "/app/packages/shared",
      entrypoint: ["node"],
      command: ["-e", storageInitScript],
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
      env: {
        ...env,
        PORT: "8080",
        SCHEDULER_WORKER_TYPES: targetIds.join(","),
        SCHEDULER_POLL_INTERVAL_MS: "2000",
      },
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

/** Build the service definition for an explicitly enabled Docker coding worker. */
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
      // Local server runs use the gateway by default. Compose-only ACP Claude
      // Code still pins PROXY_BACKEND=devproxy explicitly, so removing that pin
      // cannot silently choose the old sidecar in new server deployments.
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

/** Model scanner job for Docker workers; host workers discover models through ACP. */
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
    env: {
      ...commonEnv(),
      ...providerEnv(options.env ?? process.env),
      ...buildEnvironment(options.manifest),
      API_URL: "http://api:80",
    },
  };
}
