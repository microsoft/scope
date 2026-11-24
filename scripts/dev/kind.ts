// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TENANT, renderEdgeRoutes, resolveDevConfig, resolveRuntimeEnv } from "./config.js";
import { runtimes, type RuntimeEntry } from "./inventory.js";

type Resource = Record<string, unknown>;
export const namespace = "scope-dev";
const entraImage = "ghcr.io/cmaneu/entra-local@sha256:70584ef110914d100409cb3d63a63548ccdde10ca780f9751755f1482dec5d7e";
const edgeImage = "nginx@sha256:5b4900b042ccfa8b0a73df622c3a60f2322faeb2be800cbee5aa7b44d241649e";

/**
 * Idempotently initiate the single-member replica set and wait until it is writable.
 * mongosh `--eval` rejects `await` inside loop bodies, so the retry pause uses its synchronous `sleep()`.
 */
export const MONGO_REPLICA_SET_INIT = [
  "for (let attempt = 0; attempt < 90; attempt++) {",
  "  try {",
  "    try { rs.status() } catch (error) {",
  "      if (error.code !== 94) throw error;",
  "      rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] });",
  "    }",
  "    if (db.hello().isWritablePrimary) quit(0);",
  "  } catch (error) { print(error.message) }",
  "  sleep(2000);",
  "}",
  "quit(1);",
].join("\n");

function identity(name: string): Resource {
  return { apiVersion: "v1", kind: "ServiceAccount", metadata: { name, namespace }, automountServiceAccountToken: false };
}

function service(name: string, port: number, targetPort = port): Resource {
  return { apiVersion: "v1", kind: "Service", metadata: { name, namespace }, spec: { selector: { app: name }, ports: [{ name: "http", port, targetPort }] } };
}

function deployment(name: string, image: string, container: Resource, pod: Resource = {}): Resource {
  return { apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace }, spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, automountServiceAccountToken: false, terminationGracePeriodSeconds: 120, containers: [{ name, image, imagePullPolicy: image.startsWith("scope-local/") ? "Never" : "IfNotPresent", resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "2", memory: "2Gi" } }, ...container }], ...pod } } } };
}

function claim(name: string): Resource[] {
  return [
    { apiVersion: "v1", kind: "PersistentVolume", metadata: { name: `scope-dev-${name}` }, spec: { capacity: { storage: "20Gi" }, accessModes: ["ReadWriteOnce"], persistentVolumeReclaimPolicy: "Retain", storageClassName: "", hostPath: { path: `/scope-state/${name}`, type: "DirectoryOrCreate" }, claimRef: { name, namespace } } },
    { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name, namespace }, spec: { storageClassName: "", volumeName: `scope-dev-${name}`, accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "20Gi" } } } },
  ];
}

function job(name: string, image: string, command: string[], suspended = true): Resource {
  return { apiVersion: "batch/v1", kind: "Job", metadata: { name, namespace }, spec: { suspend: suspended, backoffLimit: 2, activeDeadlineSeconds: 600, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, automountServiceAccountToken: false, restartPolicy: "Never", containers: [{ name, image, imagePullPolicy: image.startsWith("scope-local/") ? "Never" : "IfNotPresent", command, envFrom: [{ configMapRef: { name: "scope-runtime" } }], volumeMounts: [{ name: "public-ca", mountPath: "/ca", readOnly: true }] }], volumes: [{ name: "public-ca", configMap: { name: "public-ca" } }] } } } };
}

function appCommand(entry: RuntimeEntry): string[] {
  if (entry.name === "portal") return ["pnpm", "--filter", "portal", "dev", "--host", "0.0.0.0", "--port", "5100", "--strictPort"];
  if (entry.name === "website") return ["pnpm", "--dir", "website", "exec", "astro", "dev", "--host", "0.0.0.0"];
  if (entry.name === "storybook") return ["pnpm", "--filter", "portal", "exec", "storybook", "dev", "--host", "0.0.0.0", "--port", "6100", "--no-open"];
  if (entry.name === "tests") return ["pnpm", "exec", "vitest", "run"];
  if (entry.name === "prompt-evaluations") return ["pnpm", "eval:static-prompts:smoke"];
  return ["node", ...(entry.kind === "service" ? ["--watch"] : []), "--conditions=source", "--enable-source-maps", "--import", "tsx", `${entry.directory}/${entry.entry}`, ...(entry.name === "db-migrations" ? ["up"] : entry.name === "cli" ? ["--help"] : [])];
}

/** Render the complete local stack; live consumers and scheduled utilities remain opt-in. */
export function renderKindStack(env: NodeJS.ProcessEnv = {}): Resource[] {
  const config = resolveDevConfig(env);
  const settings = { ...resolveRuntimeEnv({ process: env }, "kind"), PORT: "80", NODE_EXTRA_CA_CERTS: "/ca/rootCA.pem", AZURE_KEYVAULT_URI: "https://lowkey-vault:8443", IDENTITY_ENDPOINT: "http://lowkey-vault:8080/metadata/identity/oauth2/token", IDENTITY_HEADER: "header" };
  const edgeConfig = renderEdgeRoutes({ ...config, edgePort: 8080 }, { api: "http://api:80", portal: "http://portal:5100", entra: "https://entra-local:8443" });
  const resources: Resource[] = [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } },
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "scope-runtime", namespace }, data: settings },
    { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "dev-edge", namespace }, data: { "default.conf": edgeConfig } },
    ...["mongodb", "redis", "azurite", "lowkey-vault", "entra-local", "agent-workspaces"].flatMap(claim),
  ];
  const volume = (name: string): Resource => ({ name: "data", persistentVolumeClaim: { claimName: name } });
  const mount = [{ name: "data", mountPath: "/data" }];
  resources.push(identity("mongodb"), service("mongodb", 27017), deployment("mongodb", "mongo:7.0.17", { command: ["mongod", "--replSet", "rs0", "--bind_ip_all", "--dbpath", "/data/db"], volumeMounts: mount, readinessProbe: { exec: { command: ["mongosh", "--quiet", "--eval", "db.adminCommand({ping:1}).ok || quit(1)"] }, periodSeconds: 3 } }, { volumes: [volume("mongodb")] }));
  resources.push(identity("mongo-init"), job("mongo-init", "mongo:7.0.17", ["mongosh", "--host", "mongodb", "--quiet", "--eval", MONGO_REPLICA_SET_INIT]));
  resources.push(identity("redis"), service("redis", 6379), deployment("redis", "redis:7.4.2-alpine", { command: ["redis-server", "--appendonly", "yes"], volumeMounts: mount, readinessProbe: { exec: { command: ["redis-cli", "ping"] }, periodSeconds: 3 } }, { volumes: [volume("redis")] }));
  resources.push(identity("azurite"), { apiVersion: "v1", kind: "Service", metadata: { name: "azurite", namespace }, spec: { selector: { app: "azurite" }, ports: [10000, 10001, 10002].map((port) => ({ name: `port-${port}`, port })) } }, deployment("azurite", "mcr.microsoft.com/azure-storage/azurite:3.29.0", { command: ["azurite", "--skipApiVersionCheck", "--loose", "--blobHost", "0.0.0.0", "--queueHost", "0.0.0.0", "--tableHost", "0.0.0.0", "--location", "/data"], volumeMounts: mount, readinessProbe: { tcpSocket: { port: 10001 }, periodSeconds: 3 } }, { volumes: [volume("azurite")] }));
  const leafVolumes = [{ name: "certificates", secret: { secretName: "development-certificates" } }, { name: "public-ca", configMap: { name: "public-ca" } }];
  const leafMounts = [{ name: "certificates", mountPath: "/certs", readOnly: true }, { name: "public-ca", mountPath: "/ca", readOnly: true }];
  resources.push(identity("entra-local"), service("entra-local", 8443), deployment("entra-local", entraImage, { env: [{ name: "PUBLIC_ORIGIN", value: config.publicOrigin }, { name: "ISSUER", value: `${config.publicOrigin}/${config.tenant}/v2.0` }, { name: "TLS_ENABLED", value: "true" }, { name: "TLS_CERT", value: "/certs/edge.pem" }, { name: "TLS_KEY", value: "/certs/edge-key.pem" }], volumeMounts: [...leafMounts, { name: "data", mountPath: "/app/data" }], readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 3 } }, { volumes: [...leafVolumes, volume("entra-local")], securityContext: { fsGroup: 1000 }, initContainers: [{ name: "permissions", image: entraImage, securityContext: { runAsUser: 0 }, command: ["chown", "1000:1000", "/app/data"], volumeMounts: [{ name: "data", mountPath: "/app/data" }] }] }));
  resources.push(identity("lowkey-vault"), { apiVersion: "v1", kind: "Service", metadata: { name: "lowkey-vault", namespace }, spec: { selector: { app: "lowkey-vault" }, ports: [{ name: "https", port: 8443 }, { name: "identity", port: 8080 }] } }, deployment("lowkey-vault", "nagyesta/lowkey-vault:7.2.0-ubi10-minimal", { env: [{ name: "SERVER_SSL_KEY_STORE", value: "file:/certs/lowkey.p12" }, { name: "SERVER_SSL_KEY_STORE_PASSWORD", value: "scope-local-development" }, { name: "LOWKEY_ARGS", value: "--server.port=8443 --LOWKEY_VAULT_NAMES=- --LOWKEY_EXPORT_LOCATION=/data/export.json" }], volumeMounts: [...leafMounts, ...mount], readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 5 } }, { volumes: [...leafVolumes, volume("lowkey-vault")] }));
  for (const entry of runtimes) {
    if (entry.kind === "rust") {
      resources.push(identity(entry.name), service(entry.name, 18000), deployment(entry.name, `scope-local/${entry.name}:development`, { ports: [{ containerPort: 18000 }, { containerPort: 18897 }], readinessProbe: { tcpSocket: { port: 18897 }, periodSeconds: 5 } }));
      continue;
    }
    resources.push(identity(entry.name));
    const image = `scope-local/${entry.dockerfile ? entry.name : "tools"}:development`;
    if (entry.kind === "utility" || entry.kind === "tool") {
      resources.push(job(entry.name, image, appCommand(entry), true));
      continue;
    }
    const port = entry.name === "portal" ? 5100 : 80;
    const app = deployment(entry.name, image, { workingDir: "/app", command: appCommand(entry), envFrom: [{ configMapRef: { name: "scope-runtime" } }], env: [{ name: "PORT", value: String(port) }, { name: "NODE_EXTRA_CA_CERTS", value: "/ca/rootCA.pem" }, { name: "SCHEDULER_TARGET_QUEUE_DEPTH", value: "1" }], ports: [{ containerPort: port }], volumeMounts: [{ name: "public-ca", mountPath: "/ca", readOnly: true }], ...(entry.kind === "service" ? { startupProbe: { tcpSocket: { port }, periodSeconds: 3, failureThreshold: 100 }, readinessProbe: entry.name === "api" ? { httpGet: { path: "/ready", port }, periodSeconds: 3 } : { tcpSocket: { port }, periodSeconds: 3 } } : {}) }, { volumes: [{ name: "public-ca", configMap: { name: "public-ca" } }] });
    if (entry.kind === "worker") (app.spec as Record<string, unknown>).replicas = 0;
    resources.push(service(entry.name, port), app);
  }
  resources.push(identity("dev-edge"), deployment("dev-edge", edgeImage, { volumeMounts: [...leafMounts, { name: "config", mountPath: "/etc/nginx/conf.d", readOnly: true }], readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 3 } }, { volumes: [...leafVolumes, { name: "config", configMap: { name: "dev-edge" } }] }));
  resources.push({ apiVersion: "v1", kind: "Service", metadata: { name: "dev-edge", namespace }, spec: { type: "NodePort", selector: { app: "dev-edge" }, ports: [{ name: "edge", port: 8080, targetPort: 8080, nodePort: 30080 }] } });
  for (const name of ["storage-init", "redirect-init", "db-migrate", "register-agents"]) {
    resources.push(identity(name), job(name, "scope-local/tools:development", ["node", "--import", "tsx", "scripts/dev/bootstrap.ts", name]));
  }
  const entra = resources.find((resource) => resource.kind === "Deployment" && (resource.metadata as { name: string }).name === "entra-local");
  const entraSpec = entra!.spec as { template: { spec: { containers: { env: { name: string; value: string }[] }[] } } };
  entraSpec.template.spec.containers[0].env.push({ name: "TENANT_ID", value: config.tenant });
  const vault = resources.find((resource) => resource.kind === "Deployment" && (resource.metadata as { name: string }).name === "lowkey-vault");
  const vaultSpec = vault!.spec as { template: { spec: { securityContext?: unknown; initContainers?: unknown[]; containers: { command?: string[]; env: { name: string; value: string }[] }[] } } };
  const vaultPod = vaultSpec.template.spec;
  vaultPod.securityContext = { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 };
  vaultPod.initContainers = [{ name: "permissions", image: "nagyesta/lowkey-vault:7.2.0-ubi10-minimal", securityContext: { runAsUser: 0 }, command: ["chown", "1000:1000", "/data"], volumeMounts: mount }];
  const seed = JSON.stringify({ vaults: [{ attributes: { baseUri: "https://lowkey-vault:8443", recoveryLevel: "Recoverable+Purgeable", recoverableDays: 90, created: 0, deleted: null }, keys: {}, secrets: {}, certificates: {} }] });
  vaultPod.containers[0].command = ["/bin/sh", "-c", `[ -f /data/export.json ] || printf '%s\\n' '${seed}' > /data/export.json; exec java -jar /lowkey-vault.jar $LOWKEY_ARGS`];
  vaultPod.containers[0].env.find((value) => value.name === "LOWKEY_ARGS")!.value += " --LOWKEY_IMPORT_LOCATION=/data/export.json";
  annotateConfigHashes(resources, { "scope-runtime": settings, "dev-edge": { "default.conf": edgeConfig } });
  const tag = env.SCOPE_IMAGE_TAG || "development";
  if (!/^[a-zA-Z\d_.-]+$/.test(tag)) throw new Error("Invalid SCOPE_IMAGE_TAG");
  return JSON.parse(JSON.stringify(resources).replaceAll(":development\"", `:${tag}\"`)) as Resource[];
}

/**
 * Stamp each Deployment's pod template with a hash of the ConfigMaps it consumes.
 * ConfigMap edits (for example a new PUBLIC_ORIGIN) never restart pods on their own:
 * env is read once at start and nginx does not reload mounted config.
 *
 * @param resources Rendered stack, mutated in place.
 * @param configMaps ConfigMap name -> data, for every ConfigMap whose consumers must roll.
 */
function annotateConfigHashes(resources: Resource[], configMaps: Record<string, Record<string, string>>): void {
  for (const resource of resources) {
    if (resource.kind !== "Deployment") continue;
    const template = (resource.spec as { template: { metadata: { annotations?: Record<string, string> }; spec: unknown } }).template;
    const podSpec = JSON.stringify(template.spec);

    // Hash only the ConfigMaps this pod references, so backing services do not restart needlessly.
    const consumed = Object.keys(configMaps).filter((name) => podSpec.includes(`"name":"${name}"`));
    if (!consumed.length) continue;
    const hash = createHash("sha256");
    for (const name of consumed) hash.update(name).update(JSON.stringify(configMaps[name]));
    template.metadata.annotations = { ...template.metadata.annotations, "scope.dev/config-hash": hash.digest("hex").slice(0, 16) };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] || ".dev-state/runtime/kustomize");
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "resources.json"), JSON.stringify({ apiVersion: "v1", kind: "List", items: renderKindStack(process.argv.includes("--defaults") ? { AUTH_TENANT_ID: DEFAULT_TENANT } : process.env) }, null, 2));
  writeFileSync(resolve(directory, "kustomization.yaml"), "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - resources.json\n");
  console.log(`Generated ${directory}`);
}