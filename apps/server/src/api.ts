// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildEnvironment, imageTag, type AssetManifest, type TargetId } from "./manifest.js";

/** HTTP failure from the colocated Scope API, preserving status for retry decisions. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * Call the colocated API with short bounded retries.
 *
 * These launcher calls are either reads or idempotent keyed upserts, so retrying
 * transient HTTP/transport failures cannot duplicate benchmark work.
 */
export async function apiRequest(base: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(new URL(path, base), {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new ApiError(
          response.status,
          `Scope API ${method} ${path}: ${response.status} ${await response.text()}`,
        );
      }
      return await response.json() as unknown;
    } catch (error) {
      const transient = error instanceof TypeError ||
        (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) ||
        (error instanceof ApiError && [429, 500, 502, 503, 504].includes(error.status));
      if (!transient || attempt === 2) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }
}

/** Register one worker target and retire stale versions for that same target ID. */
export async function registerAgent(
  apiUrl: string,
  assets: string,
  id: TargetId,
  manifest: AssetManifest,
  agentVersion: string,
  components: Record<string, string>,
): Promise<void> {
  const baseId = id.replace(/-host$/, "");
  const definition: unknown = JSON.parse(await readFile(join(assets, `${baseId}.json`), "utf8"));
  if (
    typeof definition !== "object" || definition === null ||
    !("name" in definition) ||
    typeof definition.name !== "string"
  ) {
    throw new Error(`Invalid bundled agent definition: ${baseId}`);
  }
  await apiRequest(apiUrl, "/api/v1/agents", "POST", {
    ...definition, _id: id,
    name: `${definition.name}${id.endsWith("-host") ? " (host)" : ""}`,
    available: false,
  });
  const versions = await apiRequest(apiUrl, `/api/v1/agents/${id}/versions?status=active`);
  if (!Array.isArray(versions)) throw new Error("Invalid agent versions response");
  for (const value of versions as unknown[]) {
    if (
      typeof value !== "object" || value === null ||
      !("agentVersion" in value) ||
      typeof value.agentVersion !== "string"
    ) {
      throw new Error("Invalid agent version response");
    }
    if (value.agentVersion !== agentVersion) {
      await apiRequest(
        apiUrl,
        `/api/v1/agents/${id}/versions/${encodeURIComponent(value.agentVersion)}`,
        "PATCH",
        { status: "retired" },
      );
    }
  }
  const { BUILD_TIME: buildTime, GIT_COMMIT: gitCommit } = buildEnvironment(manifest);
  await apiRequest(apiUrl, `/api/v1/agents/${id}/versions`, "POST", {
    agentVersion,
    workerVersion: `${agentVersion}-${buildTime}-${gitCommit}`,
    components,
    gitCommit,
    buildTime,
    imageTag: id.endsWith("-host") ? `host-${imageTag(manifest)}` : `scope-local/${id}:${imageTag(manifest)}`,
    queueName: `queue-${id}`,
  });
}

/** Publish a worker's scheduler availability, ignoring missing agents during teardown races. */
export async function setAgentAvailable(apiUrl: string, id: TargetId, available: boolean): Promise<void> {
  try { await apiRequest(apiUrl, `/api/v1/agents/${id}`, "PUT", { available }); }
  catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
}

/** Normalized model catalog returned by a scanner or a host ACP discovery probe. */
export interface ModelCatalog {
  models: Array<{
    id: string;
    name?: string;
    providerAvailableFrom?: string;
    providerEndOfLife?: string;
    metadata?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
  }>;
  defaultModel?: string;
}

/** Extract the scanner's JSON catalog from its dry-run log output. */
export function parseScannerModels(output: string): ModelCatalog {
  const marker = "--- Dry-run output ---";
  const start = output.indexOf(marker);
  if (start < 0) throw new Error("Model scanner did not return its catalog");
  const value: unknown = JSON.parse(output.slice(start + marker.length).trim());
  if (typeof value !== "object" || value === null || !("models" in value) ||
    !Array.isArray(value.models) || value.models.length === 0 ||
    !value.models.every((model: unknown) => typeof model === "object" && model !== null &&
      "id" in model && typeof model.id === "string" && model.id.length > 0)) {
    throw new Error("Model scanner returned an empty or invalid model catalog");
  }
  return value as ModelCatalog;
}

/** Sync advertised models, then set the agent default if the scanner supplied one. */
export async function registerModels(apiUrl: string, id: TargetId, discovery: ModelCatalog): Promise<void> {
  await apiRequest(apiUrl, "/api/v1/models/sync", "POST", {
    agentId: id,
    provider: id.includes("copilot") ? "github-copilot" : "anthropic",
    models: discovery.models.map(({ name, ...model }) => ({
      ...model,
      ...(name ? { metadata: { ...model.metadata, name } } : {}),
    })),
    scannedAt: new Date().toISOString(),
  });
  if (discovery.defaultModel) {
    await apiRequest(apiUrl, `/api/v1/agents/${id}`, "PUT", { defaultModel: discovery.defaultModel });
  }
}
