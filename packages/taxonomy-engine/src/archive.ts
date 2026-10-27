// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract } from "tar-stream";
import { z } from "zod";
import type { RunState } from "shared";
import { RunStateSchema } from "shared/schemas/request";
import { loadBytes } from "./input.js";
import {
  parseScopeAtif,
  SCOPE_ATIF_EXTENSION_VERSION,
  validateScopeAtif,
  type ScopeAtif,
  type ScopeSource,
} from "./scope-atif.js";
import { parseSafeYamlText, type NormalizedTaxonomy } from "./taxonomy.js";

/** Safety limits for Scope run archive ingestion. */
export interface ArchiveLimits {
  /** Maximum compressed input bytes; default 32 MiB. */
  maxCompressedBytes?: number;
  /** Maximum expanded bytes across all entries; default 128 MiB. */
  maxExpandedBytes?: number;
  /** Maximum tar entries; default 1000. */
  maxEntries?: number;
  /** Maximum slash-separated path depth; default 3. */
  maxPathDepth?: number;
}

const archiveRootSchema = z.object({
  _id: z.string().min(1),
  workerType: z.string().optional(),
  scenario: z.object({
    _id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    task: z.string().optional(),
  }).passthrough(),
  profileId: z.string().optional(),
  profileVersionId: z.string().optional(),
  mcpServers: z.array(z.string()).optional(),
  skillRevisions: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  resources: z.array(z.union([
    z.string(),
    z.object({ slug: z.string().optional(), ref: z.string().optional() }).passthrough(),
  ])).optional(),
  run: z.unknown(),
}).passthrough();

const toolCallLineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.unknown()),
  response: z.unknown().optional(),
  timestamp: z.string().optional(),
}).passthrough();

/** In-memory files selected from one validated Scope run archive. */
interface ArchiveInventory {
  /** Single archive root directory. */
  root: string;
  /** Entry bytes keyed by relative path below root. */
  files: Map<string, Buffer>;
}

/** Rejects paths that could escape or create ambiguous archive roots. */
function parseArchivePath(name: string, maxDepth: number): { root: string; relativePath: string } {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
    throw new Error(`Unsafe archive entry path '${name}'`);
  }
  const segments = name.replace(/\/$/, "").split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > maxDepth) {
    throw new Error(`Archive entry '${name}' exceeds path depth ${maxDepth}`);
  }
  return { root: segments[0], relativePath: segments.slice(1).join("/") };
}

/** Extracts a gzip/tar archive into a bounded in-memory file map. */
async function extractArchive(
  compressed: Buffer,
  limits: Required<ArchiveLimits>,
): Promise<ArchiveInventory> {
  const files = new Map<string, Buffer>();
  const roots = new Set<string>();
  const extractor = extract();
  let entryCount = 0;
  let expandedBytes = 0;

  const completion = new Promise<void>((resolve, reject) => {
    extractor.on("entry", (header, stream, next) => {
      void (async () => {
        entryCount++;
        if (entryCount > limits.maxEntries) {
          throw new Error(`Archive exceeds entry limit ${limits.maxEntries}`);
        }
        if (!["file", "directory"].includes(header.type ?? "file")) {
          throw new Error(`Archive entry '${header.name}' has unsupported type '${header.type}'`);
        }

        const { root, relativePath } = parseArchivePath(header.name, limits.maxPathDepth);
        roots.add(root);
        if (roots.size > 1) {
          throw new Error("Scope archive must contain exactly one run root");
        }
        if (header.type === "directory") {
          stream.resume();
          await new Promise<void>((entryResolve, entryReject) => {
            stream.on("end", entryResolve);
            stream.on("error", entryReject);
          });
          next();
          return;
        }
        if (!relativePath) {
          throw new Error(`Archive file '${header.name}' must be inside the run root`);
        }
        if (files.has(relativePath)) {
          throw new Error(`Duplicate archive entry '${header.name}'`);
        }

        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          expandedBytes += buffer.length;
          if (expandedBytes > limits.maxExpandedBytes) {
            throw new Error(`Archive exceeds expanded byte limit ${limits.maxExpandedBytes}`);
          }
          chunks.push(buffer);
        }
        files.set(relativePath, Buffer.concat(chunks));
        next();
      })().catch(error => {
        extractor.destroy(error instanceof Error ? error : new Error(String(error)));
        reject(error);
      });
    });
    extractor.on("finish", resolve);
    extractor.on("error", reject);
  });

  await Promise.all([
    completion,
    pipeline(Readable.from(compressed), createGunzip(), extractor),
  ]);
  if (roots.size !== 1) {
    throw new Error("Scope archive does not contain one run root");
  }
  if (!files.has("run.yaml")) {
    throw new Error("Scope archive is missing run.yaml");
  }
  return { root: [...roots][0], files };
}

/** Derives availability only from explicit successful run outcomes. */
function deriveAvailableSources(
  archive: z.infer<typeof archiveRootSchema>,
  run: Pick<RunState, "mcpRegistered" | "resources">,
  taxonomy: NormalizedTaxonomy,
): ScopeSource[] {
  const sources: ScopeSource[] = [];
  const add = (values: readonly string[] | undefined, surfaceId: string) => {
    if (!taxonomy.surfaceById.has(surfaceId)) return;
    for (const value of values ?? []) {
      sources.push({ id: value, label: value, surface_id: surfaceId });
    }
  };

  if (run.mcpRegistered === true) {
    add(archive.mcpServers, "surface-mcp");
  }
  add(
    run.resources
      ?.filter(resource => resource.setupSucceeded)
      .map(resource => resource.slug || resource.ref)
      .filter(Boolean),
    "surface-docs",
  );

  const unique = new Map<string, ScopeSource>();
  for (const source of sources) {
    const existing = unique.get(source.id);
    if (existing && (
      existing.label !== source.label ||
      existing.surface_id !== source.surface_id
    )) {
      throw new Error(`Available source '${source.id}' has conflicting definitions`);
    }
    unique.set(source.id, source);
  }
  return [...unique.values()];
}

/** Parses optional iteration tool-call JSONL and rejects duplicate line IDs. */
function parseToolCallJsonl(buffer: Buffer, path: string): Map<string, z.infer<typeof toolCallLineSchema>> {
  const calls = new Map<string, z.infer<typeof toolCallLineSchema>>();
  for (const [index, line] of buffer.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON in ${path}:${index + 1}`);
    }
    const call = toolCallLineSchema.parse(value);
    if (calls.has(call.id)) {
      throw new Error(`Duplicate tool-call ID '${call.id}' in ${path}`);
    }
    calls.set(call.id, call);
  }
  return calls;
}

/**
 * Stitches one validated Scope archive into a single in-memory ATIF v1.7 stream.
 *
 * @param compressed - Complete gzip/tar bytes.
 * @param taxonomy - Loaded taxonomy used to validate surfaces and final evidence.
 * @param options - Optional archive safety limits.
 */
export async function normalizeScopeArchive(
  compressed: Buffer,
  taxonomy: NormalizedTaxonomy,
  options: ArchiveLimits = {},
): Promise<ScopeAtif> {
  const limits: Required<ArchiveLimits> = {
    maxCompressedBytes: options.maxCompressedBytes ?? 32 * 1024 * 1024,
    maxExpandedBytes: options.maxExpandedBytes ?? 128 * 1024 * 1024,
    maxEntries: options.maxEntries ?? 1000,
    maxPathDepth: options.maxPathDepth ?? 3,
  };
  if (compressed.length > limits.maxCompressedBytes) {
    throw new Error(`Archive exceeds compressed byte limit ${limits.maxCompressedBytes}`);
  }

  const inventory = await extractArchive(compressed, limits);
  const archive = archiveRootSchema.parse(
    parseSafeYamlText(inventory.files.get("run.yaml")!.toString("utf8"), `${inventory.root}/run.yaml`),
  );
  const runResult = RunStateSchema.safeParse(archive.run);
  if (!runResult.success) {
    throw new Error(`Archive run.yaml has invalid run state: ${runResult.error.message}`);
  }
  const run = runResult.data;
  const turns = [...(run.turns ?? [])].sort((left, right) => left.iteration - right.iteration);
  if (!turns.length) {
    throw new Error("Archive run contains no iterations");
  }
  if (new Set(turns.map(turn => turn.iteration)).size !== turns.length) {
    throw new Error("Archive run contains duplicate iteration numbers");
  }
  if (run.status === "done" && !run.finishedAt) {
    throw new Error("Terminal archive run is missing finishedAt");
  }

  const trajectories = turns.map(turn => {
    const path = `iteration-${turn.iteration}.atif.trajectory.json`;
    const bytes = inventory.files.get(path);
    if (!bytes) {
      throw new Error(`Archive is missing required ${path}; Taxonome does not regenerate ATIF from HAR`);
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`Invalid JSON in ${path}`);
    }
    return { iteration: turn.iteration, path, atif: parseScopeAtif(value) };
  });

  const callCounts = new Map<string, number>();
  for (const { atif } of trajectories) {
    for (const call of atif.steps.flatMap(step => step.tool_calls ?? [])) {
      callCounts.set(call.tool_call_id, (callCounts.get(call.tool_call_id) ?? 0) + 1);
    }
  }
  const callIdMaps = new Map<number, Map<string, string>>();
  const canonicalCallIds = new Set<string>();
  for (const { iteration, atif } of trajectories) {
    const callIdMap = new Map<string, string>();
    for (const call of atif.steps.flatMap(step => step.tool_calls ?? [])) {
      const canonical = (callCounts.get(call.tool_call_id) ?? 0) > 1
        ? `iteration-${iteration}:${call.tool_call_id}`
        : call.tool_call_id;
      callIdMap.set(call.tool_call_id, canonical);
      canonicalCallIds.add(canonical);
    }
    callIdMaps.set(iteration, callIdMap);
  }

  const steps: ScopeAtif["steps"] = [];
  let nextStepId = 1;
  const archiveSources = deriveAvailableSources(archive, run, taxonomy);
  const sourceMap = new Map(archiveSources.map(source => [source.id, source]));

  for (const { iteration, path, atif } of trajectories) {
    for (const source of atif.extra?.scope?.available_sources ?? []) {
      const existing = sourceMap.get(source.id);
      if (existing && (
        existing.label !== source.label ||
        existing.surface_id !== source.surface_id
      )) {
        throw new Error(`Source '${source.id}' conflicts between run.yaml and ${path}`);
      }
      sourceMap.set(source.id, source);
    }

    const callIdMap = callIdMaps.get(iteration)!;
    const toolCallPath = `iteration-${iteration}.tool-calls.jsonl`;
    const extraCalls = inventory.files.has(toolCallPath)
      ? parseToolCallJsonl(inventory.files.get(toolCallPath)!, toolCallPath)
      : new Map();

    for (const originalStep of atif.steps) {
      const step = structuredClone(originalStep);
      const originalStepId = step.step_id;
      step.step_id = nextStepId++;
      step.extra = {
        ...(step.extra ?? {}),
        scope: {
          ...(step.extra?.scope ?? {}),
          origin: { iteration, step_id: originalStepId },
        },
      };

      for (const call of step.tool_calls ?? []) {
        const originalCallId = call.tool_call_id;
        call.tool_call_id = callIdMap.get(originalCallId)!;
        const supplemental = extraCalls.get(originalCallId);
        call.extra = {
          ...(call.extra ?? {}),
          scope: {
            ...(call.extra?.scope ?? {}),
            origin: { iteration, tool_call_id: originalCallId },
            ...(supplemental?.response !== undefined
              ? { response: supplemental.response }
              : {}),
          },
        };
        if (supplemental) extraCalls.delete(originalCallId);
      }

      for (const result of step.observation?.results ?? []) {
        if (result.source_call_id) {
          const originalSourceCallId = result.source_call_id;
          const candidates = [...callIdMaps.values()]
            .map(mapping => mapping.get(originalSourceCallId))
            .filter((candidate): candidate is string => Boolean(candidate));
          const rewritten = canonicalCallIds.has(originalSourceCallId)
            ? originalSourceCallId
            : callIdMap.get(originalSourceCallId) ??
              (new Set(candidates).size === 1 ? candidates[0] : undefined);
          if (!rewritten) {
            throw new Error(
              `${path} observation references unknown or ambiguous call '${originalSourceCallId}'`,
            );
          }
          result.source_call_id = rewritten;
        }
      }
      steps.push(step);
    }

    if (extraCalls.size) {
      throw new Error(
        `${toolCallPath} contains calls not present in its ATIF: ${[...extraCalls.keys()].join(", ")}`,
      );
    }
  }

  const trajectoryState = run.status !== "done"
    ? "partial"
    : trajectories.some(({ atif }) =>
      atif.extra?.scope?.trajectory_state === "unknown"
    )
      ? "unknown"
      : trajectories.some(({ atif }) =>
        atif.extra?.scope?.trajectory_state !== "complete"
      )
        ? "partial"
        : "complete";
  const scenario = archive.scenario;
  const normalized = parseScopeAtif({
    schema_version: "ATIF-v1.7",
    session_id: `${archive._id}:${run._id}`,
    agent: { name: archive.workerType ?? "scope-run" },
    steps,
    extra: {
      scope: {
        schema_version: SCOPE_ATIF_EXTENSION_VERSION,
        trajectory_state: trajectoryState,
        ...(scenario.task ? { task: scenario.task } : {}),
        run: {
          request_id: archive._id,
          id: run._id,
          scenario_id: scenario._id ?? scenario.id,
          scenario_label: scenario.name,
          profile_id: archive.profileId ?? archive.profileVersionId,
        },
        available_sources: [...sourceMap.values()],
        configured_capabilities: {
          skills: archive.skillRevisions,
          mcp_servers: archive.mcpServers,
          extensions: archive.extensions,
          resources: archive.resources?.map(resource =>
            typeof resource === "string" ? resource : resource.slug ?? resource.ref ?? "",
          ).filter(Boolean),
        },
        actual_outcomes: {
          ...(run.mcpRegistered !== undefined
            ? { mcp_registered: run.mcpRegistered }
            : {}),
          ...(run.resources ? { resources: run.resources } : {}),
        },
      },
    },
  });
  validateScopeAtif(normalized, taxonomy);
  return normalized;
}

/**
 * Auto-detects plain JSON versus gzip/tar by content and returns normalized ATIF.
 *
 * @param location - Local path or HTTP(S) URL.
 * @param taxonomy - Loaded taxonomy used for evidence validation.
 */
export async function loadAtifInput(
  location: string,
  taxonomy: NormalizedTaxonomy,
): Promise<ScopeAtif> {
  const bytes = await loadBytes(location, { maxBytes: 32 * 1024 * 1024 });
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return normalizeScopeArchive(bytes, taxonomy);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Input is neither JSON ATIF nor a gzip Scope archive");
  }
  const atif = parseScopeAtif(value);
  validateScopeAtif(atif, taxonomy);
  return atif;
}
