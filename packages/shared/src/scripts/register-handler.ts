// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Generic post-process handler registration script.
 *
 * Replaces the per-worker, inlined `register-version.ts` scripts that wrote
 * directly to MongoDB. Reads a declarative `handler.yaml` (path from
 * HANDLER_YAML_PATH) and POSTs it to the scheduler's
 * `POST /handlers/register` endpoint (the scheduler owns the `services`
 * collection). Used identically by docker-compose init services and the K8s
 * registration Jobs.
 *
 * Mirrors the coding-agent registration pattern (`agent.yaml` →
 * `POST /api/v1/agents`).
 *
 * Environment:
 *   HANDLER_YAML_PATH  Path to the handler.yaml file (required)
 *   SCHEDULER_URL      Base URL of the scheduler HTTP server, e.g.
 *                      http://scheduler:8080 (required)
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { HandlerServiceDocument } from "../types/types.js";

const HEALTH_RETRIES = 30;
const HEALTH_DELAY_MS = 3_000;
const POST_RETRIES = 10;
const POST_DELAY_MS = 3_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the parsed YAML conforms to the HandlerServiceDocument shape. */
export function parseHandlerDocument(raw: unknown): HandlerServiceDocument {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("handler.yaml must contain a mapping");
  }
  const doc = raw as Record<string, unknown>;

  if (!isNonEmptyString(doc._id)) {
    throw new Error("handler.yaml: '_id' is required");
  }
  if (doc.type !== "post-process-handler") {
    throw new Error("handler.yaml: 'type' must be 'post-process-handler'");
  }
  if (typeof doc.version !== "number" || !Number.isFinite(doc.version)) {
    throw new Error("handler.yaml: 'version' must be a number");
  }
  if (!isNonEmptyString(doc.queue)) {
    throw new Error("handler.yaml: 'queue' is required");
  }
  if (!isNonEmptyString(doc.selector)) {
    throw new Error("handler.yaml: 'selector' is required");
  }
  if (typeof doc.autoBackfill !== "boolean") {
    throw new Error("handler.yaml: 'autoBackfill' must be a boolean");
  }
  const dependsOn = doc.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || !dependsOn.every((d) => isNonEmptyString(d))) {
    throw new Error("handler.yaml: 'dependsOn' must be an array of strings");
  }

  return {
    _id: doc._id,
    type: "post-process-handler",
    version: doc.version,
    queue: doc.queue,
    selector: doc.selector,
    autoBackfill: doc.autoBackfill,
    dependsOn: dependsOn as string[],
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForScheduler(schedulerUrl: string): Promise<void> {
  for (let attempt = 1; attempt <= HEALTH_RETRIES; attempt++) {
    try {
      const res = await fetch(`${schedulerUrl}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // not ready yet
    }
    console.log(
      `[register-handler] Scheduler not ready (attempt ${attempt}/${HEALTH_RETRIES}), retrying in ${HEALTH_DELAY_MS}ms...`,
    );
    await delay(HEALTH_DELAY_MS);
  }
  throw new Error(`Scheduler did not become healthy at ${schedulerUrl}`);
}

async function postRegistration(
  schedulerUrl: string,
  doc: HandlerServiceDocument,
): Promise<void> {
  for (let attempt = 1; attempt <= POST_RETRIES; attempt++) {
    try {
      const res = await fetch(`${schedulerUrl}/handlers/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });
      if (res.ok) {
        return;
      }
      const body = await res.text();
      console.log(
        `[register-handler] Register failed (attempt ${attempt}/${POST_RETRIES}): HTTP ${res.status} ${body}`,
      );
    } catch (err) {
      console.log(
        `[register-handler] Register error (attempt ${attempt}/${POST_RETRIES}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await delay(POST_DELAY_MS);
  }
  throw new Error(`Failed to register handler ${doc._id} after ${POST_RETRIES} attempts`);
}

export async function registerHandlerFromYaml(
  yamlPath: string,
  schedulerUrl: string,
): Promise<HandlerServiceDocument> {
  const content = await readFile(yamlPath, "utf-8");
  const doc = parseHandlerDocument(parseYaml(content));

  console.log(
    `[register-handler] Registering ${doc._id} (version=${doc.version}, queue=${doc.queue}) at ${schedulerUrl}`,
  );

  await waitForScheduler(schedulerUrl);
  await postRegistration(schedulerUrl, doc);

  console.log(`[register-handler] Registered ${doc._id} successfully`);
  return doc;
}

async function main(): Promise<void> {
  const yamlPath = process.env.HANDLER_YAML_PATH;
  const schedulerUrl = process.env.SCHEDULER_URL;

  if (!yamlPath) {
    throw new Error("HANDLER_YAML_PATH is required");
  }
  if (!schedulerUrl) {
    throw new Error("SCHEDULER_URL is required");
  }

  await registerHandlerFromYaml(yamlPath, schedulerUrl.replace(/\/+$/, ""));
}

// Only run when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error("[register-handler] Fatal error:", err);
    process.exit(1);
  });
}
