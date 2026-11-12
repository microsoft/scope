// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveRuntimeEnv, type RuntimeInputs } from "./config.js";
import { runtimeByName } from "./inventory.js";

interface ComposeService {
  environment?: Record<string, string>;
  depends_on?: Record<string, unknown>;
  volumes?: { type: string; source?: string }[];
  [key: string]: unknown;
}
interface ComposeModel {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

/** Reuse the production worker/sidecar graph without starting duplicate native services. */
export function renderNativeWorkers(model: ComposeModel, selected: string[], inputs: RuntimeInputs, project: string): ComposeModel & { networks: unknown } {
  const allowed = new Set(["coder-acp-copilot", "coder-acp-claude-code", "report-generator", "post-processor", "gateway", "devproxy-claude-code", "devproxy-claude-code-init", "mcp-gateway-copilot", "mcp-gateway-claude-code", "register-version-post-processor"]);
  const included = new Set<string>();
  const visit = (name: string): void => {
    if (included.has(name) || !allowed.has(name)) return;
    const service = model.services[name];
    if (!service) throw new Error(`Missing existing worker dependency ${name}`);
    included.add(name);
    for (const dependency of Object.keys(service.depends_on || {})) visit(dependency);
  };
  for (const name of selected) {
    if (runtimeByName(name).kind !== "worker") throw new Error(`${name} is not a worker`);
    visit(name);
  }
  const native = resolveRuntimeEnv(inputs, "native");
  const settings = resolveRuntimeEnv(inputs, "compose");
  for (const name of ["API_ENDPOINT", "SCOPE_MT_API_URL", "JUDGE_SERVICE_URL", "TOKEN_MANAGER_URL"]) settings[name] = native[name].replace("127.0.0.1", "host.docker.internal");
  const services = Object.fromEntries([...included].map((name) => {
    const original = model.services[name];
    const service: ComposeService = { ...original, environment: { ...original.environment, ...settings }, depends_on: Object.fromEntries(Object.entries(original.depends_on || {}).filter(([dependency]) => included.has(dependency))), extra_hosts: ["host.docker.internal:host-gateway"], networks: ["default"] };
    for (const key of ["profiles", "ports", "develop", "container_name"]) delete service[key];
    const runtime = ["coder-acp-copilot", "coder-acp-claude-code", "report-generator", "post-processor"].includes(name) ? runtimeByName(name) : undefined;
    if (runtime?.inspector) service.ports = [`127.0.0.1:${runtime.inspector}:9229`];
    return [name, service];
  }));
  const usedVolumes = new Set(Object.values(services).flatMap((service) => (service.volumes || []).filter((volume) => volume.type === "volume" && volume.source).map((volume) => volume.source)));
  return { services, volumes: Object.fromEntries(Object.entries(model.volumes || {}).filter(([name]) => usedVolumes.has(name))), networks: { default: { external: true, name: `${project}_default` } } };
}

export function existingWorkerModel(root: string, env: NodeJS.ProcessEnv): ComposeModel {
  const source = execFileSync("docker", ["compose", "--env-file", "/dev/null", "--file", resolve(root, "docker-compose.yml"), "--file", resolve(root, "docker-compose.dev.yml"), "--profile", "*", "config", "--format", "json"], { env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const model: ComposeModel = JSON.parse(source);
  if (!model.services || typeof model.services !== "object") throw new Error("Invalid existing Compose worker model");
  return model;
}