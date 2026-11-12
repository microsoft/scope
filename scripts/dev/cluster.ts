// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolveDevConfig } from "./config.js";
import { execute, project, root, stateDirectory } from "./control.js";
import { renderKindStack, namespace } from "./kind.js";
import { runtimes, runtimeByName } from "./inventory.js";

export const kubeconfig = resolve(stateDirectory, "kubeconfig");
export const context = `kind-${project}`;

export function kubectl(args: string[], env = process.env): void {
  execute("kubectl", ["--kubeconfig", kubeconfig, "--context", context, "--namespace", namespace, ...args], env);
}

export function inspectorCommand(command: string[], port: number): string[] {
  if (command[0] !== "node" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("A Node entrypoint and valid inspector port are required");
  return ["node", `--inspect-brk=0.0.0.0:${port}`, ...command.slice(1).filter((argument) => argument !== "--watch" && !argument.startsWith("--inspect"))];
}

/** Forward only loopback, retry replaced service pods, and never rerun a completed utility. */
export async function debugRuntime(env: NodeJS.ProcessEnv, name: string, args: string[] = []): Promise<void> {
  const entry = runtimeByName(name);
  if (!entry.inspector) throw new Error(`${name} has no Node inspector; use its dedicated debugger profile`);
  const resource = renderKindStack({ ...env, SCOPE_IMAGE_TAG: project }).find((item) => (item.kind === "Deployment" || item.kind === "Job") && (item.metadata as { name: string }).name === name);
  if (!resource) throw new Error(`Missing workload ${name}`);
  const workload = resource.kind === "Job" ? "job" : "deployment";
  type Container = { name: string; command: string[]; startupProbe?: unknown; readinessProbe?: unknown };
  const spec = resource.spec as { suspend?: boolean; template: { spec: { containers: Container[] } } };
  const container = spec.template.spec.containers[0];
  const command = inspectorCommand([...container.command, ...args], entry.inspector);
  if (resource.kind === "Job") {
    kubectl(["delete", "job", name, "--ignore-not-found", "--wait=true", "--timeout=60s"], env);
    container.command = command;
    spec.suspend = false;
    applyObject(resource);
  } else {
    kubectl(["patch", "deployment", name, "--type=strategic", "-p", JSON.stringify({ spec: { replicas: 1, template: { spec: { containers: [{ name, command, startupProbe: null, readinessProbe: null }] } } } })], env);
  }
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  const stop = (): void => { stopping = true; child?.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`Attach ${name} at 127.0.0.1:${entry.inspector}; source root /app. No inspector Service or browser forwarding is created.`);
  try {
    while (!stopping) {
      child = spawn("kubectl", ["--kubeconfig", kubeconfig, "--context", context, "--namespace", namespace, "port-forward", "--address=127.0.0.1", `${workload}/${name}`, `${entry.inspector}:${entry.inspector}`, "--pod-running-timeout=90s"], { env, stdio: "inherit" });
      await new Promise<void>((resolvePromise, reject) => { child!.once("exit", () => resolvePromise()); child!.once("error", reject); });
      if (resource.kind === "Job") break;
      if (!stopping) await delay(1000);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    child?.kill("SIGTERM");
    if (resource.kind === "Deployment") kubectl(["patch", "deployment", name, "--type=strategic", "-p", JSON.stringify({ spec: { template: { spec: { containers: [{ name, command: container.command, startupProbe: container.startupProbe ?? null, readinessProbe: container.readinessProbe ?? null }] } } } })], env);
  }
}

/** Build serially to bound peak disk/RAM; images never require a registry. */
export function buildImages(env: NodeJS.ProcessEnv, selected: string[]): void {
  for (const name of new Set(selected)) {
    const entry = name === "tools" ? undefined : runtimeByName(name);
    const tools = !entry?.dockerfile;
    const imageName = tools ? "tools" : name;
    const dockerfile = tools ? ".devcontainer/runtime.Dockerfile" : entry.dockerfile!;
    const args = ["build", "--file", resolve(root, dockerfile), "--tag", `scope-local/${imageName}:${project}`];
    if (entry?.kind === "rust") args.push("--target", "runtime");
    else if (!tools) args.push("--target", "dev");
    const versions = entry ? resolve(root, entry.directory, "versions.env") : "";
    if (versions && existsSync(versions)) for (const [key, value] of Object.entries(parseEnv(readFileSync(versions, "utf8")))) args.push("--build-arg", `${key}=${value}`);
    execute("docker", [...args, entry?.kind === "rust" ? resolve(root, entry.directory) : root], env, root, 0);
    execute("kind", ["load", "docker-image", "--name", project, `scope-local/${imageName}:${project}`], env, root, 0);
  }
}

function applyObject(value: unknown): void {
  execFileSync("kubectl", ["--kubeconfig", kubeconfig, "--context", context, "--namespace", namespace, "apply", "-f", "-"], { input: JSON.stringify(value), stdio: ["pipe", "inherit", "inherit"], timeout: 60_000 });
}

/** Install runtime certificates only after startup, never in generated public manifests. */
function uploadCertificates(): void {
  const certificates: Record<string, string> = {};
  for (const name of ["edge.pem", "edge-key.pem"]) certificates[name] = readFileSync(resolve(root, ".dev-state/spike/certs", name)).toString("base64");
  certificates["lowkey.p12"] = readFileSync(resolve(stateDirectory, "certs/lowkey.p12")).toString("base64");
  applyObject({ apiVersion: "v1", kind: "Secret", metadata: { name: "development-certificates", namespace }, type: "Opaque", data: certificates });
  const ca = readFileSync(resolve(root, ".dev-state/spike/certs/rootCA.pem"), "utf8") + readFileSync(resolve(stateDirectory, "certs/lowkey-ca.pem"), "utf8");
  applyObject({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "public-ca", namespace }, data: { "rootCA.pem": ca } });
}

export function startCluster(env: NodeJS.ProcessEnv, selected: string[], build = false): void {
  const config = resolveDevConfig(env);
  const persistent = resolve(env.SCOPE_DEV_DATA || resolve(root, ".dev-state/persistent"));
  mkdirSync(persistent, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  const clusterFile = resolve(stateDirectory, "cluster.json");
  const node = "kindest/node:v1.32.2@sha256:142f543559cc55d64e1ab9341df08e5ced84bd2e893736da8f51320f26f5950b";
  writeFileSync(clusterFile, JSON.stringify({ kind: "Cluster", apiVersion: "kind.x-k8s.io/v1alpha4", networking: { apiServerAddress: "127.0.0.1" }, nodes: [{ role: "control-plane", image: node, extraMounts: [{ hostPath: persistent, containerPath: "/scope-state" }], extraPortMappings: [{ containerPort: 30080, hostPort: config.edgePort, listenAddress: "127.0.0.1", protocol: "TCP" }] }] }, null, 2));
  const names = execFileSync("kind", ["get", "clusters"], { encoding: "utf8", timeout: 30_000 }).split("\n");
  if (!names.includes(project)) execute("kind", ["create", "cluster", "--name", project, "--kubeconfig", kubeconfig, "--config", clusterFile, "--wait", "180s"], env);
  else execute("kind", ["export", "kubeconfig", "--name", project, "--kubeconfig", kubeconfig], env);
  const images = [...new Set(["tools", ...selected.map((name) => runtimeByName(name)).filter((entry) => entry.dockerfile).map((entry) => entry.name)])];
  if (build) buildImages(env, images);
  else for (const name of images) execute("kind", ["load", "docker-image", "--name", project, `scope-local/${name}:${project}`], env);
  const resources = renderKindStack({ ...env, SCOPE_IMAGE_TAG: project });
  for (const resource of resources) {
    if (resource.kind === "Deployment") {
      const metadata = resource.metadata as { name: string };
      if (runtimes.some((entry) => entry.name === metadata.name)) (resource.spec as Record<string, unknown>).replicas = 0;
    }
  }
  const directory = resolve(stateDirectory, "kustomize");
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "resources.json"), JSON.stringify({ apiVersion: "v1", kind: "List", items: resources }, null, 2));
  writeFileSync(resolve(directory, "kustomization.yaml"), "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - resources.json\n" + (env.SCOPE_DEV_KUBEDOCK === "true" ? "components:\n  - ../../../.devcontainer/kind/components/kubedock\n" : ""));
  applyObject({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } });
  uploadCertificates();
  for (const name of ["mongo-init", "storage-init", "redirect-init", "db-migrate", "register-agents"]) {
    kubectl(["delete", "job", name, "--ignore-not-found", "--wait=true", "--timeout=60s"], env);
  }
  kubectl(["apply", "-k", directory], env);
  for (const name of ["mongodb", "redis", "azurite", "entra-local", "lowkey-vault"]) kubectl(["rollout", "status", `deployment/${name}`, "--timeout=180s"], env);
  kubectl(["patch", "job", "mongo-init", "--type=merge", "-p", '{"spec":{"suspend":false}}'], env);
  kubectl(["wait", "--for=condition=complete", "job/mongo-init", "--timeout=180s"], env);
  for (const name of ["storage-init", "redirect-init", "db-migrate"]) {
    kubectl(["patch", "job", name, "--type=merge", "-p", '{"spec":{"suspend":false}}'], env);
    kubectl(["wait", "--for=condition=complete", `job/${name}`, "--timeout=600s"], env);
  }
  for (const name of selected) {
    const entry = runtimeByName(name);
    if (entry.kind === "tool" || entry.kind === "utility") throw new Error(`${name} is a Job; launch it explicitly with dev:job`);
    kubectl(["scale", `deployment/${name}`, "--replicas=1"], env);
    kubectl(["rollout", "status", `deployment/${name}`, "--timeout=300s"], env);
  }
  if (selected.includes("api")) {
    kubectl(["patch", "job", "register-agents", "--type=merge", "-p", '{"spec":{"suspend":false}}'], env);
    kubectl(["wait", "--for=condition=complete", "job/register-agents", "--timeout=180s"], env);
  }
  console.log(`Kind ready. Browser: ${config.publicOrigin}`);
}