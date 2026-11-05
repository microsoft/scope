// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import {
  Readable,
  Transform,
  type Readable as NodeReadable,
} from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract } from "tar-stream";
import { z } from "zod";
import type { RunState } from "shared";
import { RunStateSchema } from "shared/schemas/request";
import { loadBytes } from "./input.js";
import {
  ingestAtif,
  ingestAtifJson,
  AtifIngestionError,
  originalAtifPath,
  type AtifIngestionResult,
  type AtifProvenance,
  type AtifSourceDescriptor,
  type AtifSourceMapping,
} from "./atif/index.js";
import {
  SCOPE_ATIF_EXTENSION_VERSION,
  validateScopeAtif,
  type ScopeAtif,
  type ScopeSource,
} from "./scope-atif.js";
import { parseSafeYamlText, type NormalizedTaxonomy } from "./taxonomy.js";

/** Safety limits for Scope run archive ingestion. */
export interface ArchiveLimits {
  /** Maximum compressed input bytes; default 16 GiB. */
  maxCompressedBytes?: number;
  /** Maximum streamed tar entry bytes, including discarded entries; default 32 GiB. */
  maxStreamedBytes?: number;
  /** Maximum retained evidence bytes across all roots; default 128 MiB. */
  maxRetainedBytes?: number;
  /** Maximum tar entries; default 10000. */
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
export interface ScopeArchiveRoot {
  /** Archive root directory in deterministic tar order. */
  root: string;
  /** Zero-based root order. */
  index: number;
  /** Retained evidence bytes keyed by relative path. */
  files: Map<string, Buffer>;
  /** SHA-256 of retained evidence paths and bytes. */
  fingerprint: string;
  /** Request ID when run.yaml parses far enough to expose it. */
  requestId?: string;
  /** Run ID when run.yaml parses far enough to expose it. */
  runId?: string;
}

/** Source selection identity retained outside normalized ATIF/model evidence. */
export interface AtifInputOrigin {
  /** Canonical absolute local input path selected by the caller. */
  selected_input: string;
  /** Actual archive root when the selected input is a Scope archive. */
  archive_root?: string;
}

/** Physical input container detected by the loader. */
export type AtifInputKind = "plain" | "archive";

/** One normalized input returned by plain/archive auto-detection. */
export interface LoadedAtifInput {
  /** Explicit container kind; archive identity never depends on the root name. */
  inputKind: AtifInputKind;
  /** Plain-input sentinel or the actual archive root directory. */
  root: string;
  /** SHA-256 of canonical plain ATIF or retained archive evidence. */
  fingerprint: string;
  /** Request ID when available from Scope metadata. */
  requestId?: string;
  /** Run ID when available from Scope metadata. */
  runId?: string;
  /** Canonical normalized ATIF when ingestion succeeded. */
  atif?: ScopeAtif;
  /** Original-source provenance when ingestion succeeded. */
  provenance?: AtifProvenance;
  /** Root-scoped ingestion failure. */
  error?: Error;
}

/** Builds persisted origin metadata from explicit loader-owned container identity. */
export function createAtifInputOrigin(
  selectedInput: string,
  input: Pick<LoadedAtifInput, "inputKind" | "root">,
): AtifInputOrigin {
  return {
    selected_input: selectedInput,
    ...(input.inputKind === "archive"
      ? { archive_root: input.root }
      : {}),
  };
}

/** Stable exact key for source-scoped batch/resume/readout association. */
export function atifInputOriginKey(origin: AtifInputOrigin): string {
  return JSON.stringify([
    origin.selected_input,
    origin.archive_root ?? null,
  ]);
}

export interface ScopeArchiveScan {
  roots: ScopeArchiveRoot[];
  compressedBytes?: number;
  streamedBytes: number;
  retainedBytes: number;
  entryCount: number;
}

/** Monotonic streaming archive progress emitted before normalization. */
export interface ArchiveScanProgress {
  /** Compressed gzip bytes read before decompression. */
  compressedBytes: number;
  /** Known compressed total for local files and in-memory buffers. */
  compressedTotalBytes?: number;
  /** Tar entries observed so far. */
  entryCount: number;
  /** Distinct top-level roots discovered so far. */
  rootCount: number;
  /** Decompressed tar entry bytes consumed, including discarded entries. */
  streamedBytes: number;
  /** Evidence bytes retained for normalization. */
  retainedBytes: number;
  /** True only for the final successful scan snapshot. */
  complete: boolean;
}

/** Optional cancellation and progress hooks for streaming archive scans. */
export interface ArchiveScanOptions {
  /** Known compressed total when the source stream cannot expose it. */
  compressedTotalBytes?: number;
  /** Receives monotonic progress snapshots. */
  onProgress?: (progress: ArchiveScanProgress) => void;
  /** Cancels gzip/tar streaming and entry retention. */
  signal?: AbortSignal;
}

type ArchiveSource = Buffer | NodeReadable;

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

function retainArchiveEntry(relativePath: string): boolean {
  return relativePath === "run.yaml" ||
    /^iteration-\d+\.atif\.trajectory\.json$/.test(relativePath) ||
    /^iteration-\d+\.tool-calls\.jsonl$/.test(relativePath);
}

function rootFingerprint(files: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files.get(path)!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Streams a gzip/tar archive and retains only Taxonome evidence entries. */
export async function scanScopeArchive(
  source: ArchiveSource,
  limits: Required<ArchiveLimits>,
  options: ArchiveScanOptions = {},
): Promise<ScopeArchiveScan> {
  const roots = new Map<string, { index: number; files: Map<string, Buffer> }>();
  const seenEntries = new Set<string>();
  const extractor = extract();
  let entryCount = 0;
  let compressedBytes = 0;
  let streamedBytes = 0;
  let retainedBytes = 0;
  const compressedTotalBytes = options.compressedTotalBytes ??
    (Buffer.isBuffer(source) ? source.length : undefined);
  const report = (complete = false) => {
    options.onProgress?.({
      compressedBytes,
      ...(compressedTotalBytes !== undefined ? { compressedTotalBytes } : {}),
      entryCount,
      rootCount: roots.size,
      streamedBytes,
      retainedBytes,
      complete,
    });
  };
  const compressedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > limits.maxCompressedBytes) {
        callback(new Error(
          `Archive exceeds compressed byte limit ${limits.maxCompressedBytes}`,
        ));
        return;
      }
      try {
        report();
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  const completion = new Promise<void>((resolve, reject) => {
    extractor.on("entry", (header, stream, next) => {
      void (async () => {
        entryCount++;
        report();
        if (entryCount > limits.maxEntries) {
          throw new Error(`Archive exceeds entry limit ${limits.maxEntries}`);
        }
        if (!["file", "directory"].includes(header.type ?? "file")) {
          throw new Error(`Archive entry '${header.name}' has unsupported type '${header.type}'`);
        }

        const { root, relativePath } = parseArchivePath(header.name, limits.maxPathDepth);
        const rootInventory = roots.get(root) ?? {
          index: roots.size,
          files: new Map<string, Buffer>(),
        };
        roots.set(root, rootInventory);
        report();
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
        if (seenEntries.has(header.name)) {
          throw new Error(`Duplicate archive entry '${header.name}'`);
        }
        seenEntries.add(header.name);

        const retain = retainArchiveEntry(relativePath);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          streamedBytes += buffer.length;
          if (streamedBytes > limits.maxStreamedBytes) {
            throw new Error(`Archive exceeds streamed byte limit ${limits.maxStreamedBytes}`);
          }
          if (retain) {
            retainedBytes += buffer.length;
            if (retainedBytes > limits.maxRetainedBytes) {
              throw new Error(`Archive exceeds retained evidence byte limit ${limits.maxRetainedBytes}`);
            }
            chunks.push(buffer);
          }
          report();
        }
        if (retain) {
          if (rootInventory.files.has(relativePath)) {
            throw new Error(`Duplicate retained archive entry '${header.name}'`);
          }
          rootInventory.files.set(relativePath, Buffer.concat(chunks));
        }
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
    pipeline(
      Buffer.isBuffer(source) ? Readable.from(source) : source,
      compressedCounter,
      createGunzip(),
      extractor,
      { signal: options.signal },
    ),
  ]);
  if (!roots.size) throw new Error("Scope archive contains no run roots");

  const scannedRoots = [...roots.entries()]
    .sort(([, left], [, right]) => left.index - right.index)
    .map(([root, inventory]) => {
      const runBytes = inventory.files.get("run.yaml");
      let requestId: string | undefined;
      let runId: string | undefined;
      if (runBytes) {
        try {
          const raw = parseSafeYamlText(runBytes.toString("utf8"), `${root}/run.yaml`);
          if (raw && typeof raw === "object") {
            const record = raw as Record<string, unknown>;
            if (typeof record._id === "string") requestId = record._id;
            const run = record.run;
            if (run && typeof run === "object" && typeof (run as Record<string, unknown>)._id === "string") {
              runId = String((run as Record<string, unknown>)._id);
            }
          }
        } catch {
          // Normalization records the parse failure per root.
        }
      }
      return {
        root,
        index: inventory.index,
        files: inventory.files,
        fingerprint: rootFingerprint(inventory.files),
        ...(requestId ? { requestId } : {}),
        ...(runId ? { runId } : {}),
      };
    });
  const result = {
    roots: scannedRoots,
    compressedBytes,
    streamedBytes,
    retainedBytes,
    entryCount,
  };
  report(true);
  return result;
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
function parseToolCallJsonl(
  buffer: Buffer,
  path: string,
  source: AtifSourceDescriptor,
): Map<string, {
  call: z.infer<typeof toolCallLineSchema>;
  line: number;
}> {
  const calls = new Map<string, {
    call: z.infer<typeof toolCallLineSchema>;
    line: number;
  }>();
  for (const [index, line] of buffer.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new AtifIngestionError({
        code: "atif_invalid_archive_tool_call_json",
        stage: "decoding",
        message: "Invalid JSON in archive tool-call record.",
        ...source,
        original_path: "$",
        jsonl_line: index + 1,
      });
    }
    const parsed = toolCallLineSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const suffix = issue.path.map(segment =>
        typeof segment === "number"
          ? `[${segment}]`
          : /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(segment))
            ? `.${String(segment)}`
            : `[${JSON.stringify(String(segment))}]`
      ).join("");
      throw new AtifIngestionError({
        code: "atif_invalid_archive_tool_call",
        stage: "source_validation",
        message: issue.message,
        ...source,
        original_path: `$${suffix}`,
        jsonl_line: index + 1,
      });
    }
    const call = parsed.data;
    if (calls.has(call.id)) {
      throw new AtifIngestionError({
        code: "atif_duplicate_archive_tool_call",
        stage: "source_validation",
        message: `Duplicate tool-call ID '${call.id}' in ${path}.`,
        ...source,
        original_path: "$.id",
        jsonl_line: index + 1,
      });
    }
    calls.set(call.id, { call, line: index + 1 });
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
export async function normalizeScopeArchiveRootResult(
  inventory: ScopeArchiveRoot,
  taxonomy: NormalizedTaxonomy,
  source: AtifSourceDescriptor = {},
): Promise<AtifIngestionResult<ScopeAtif>> {
  if (!inventory.files.has("run.yaml")) {
    throw new Error(`${inventory.root} is missing run.yaml`);
  }
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
    const ingested = ingestAtifJson(bytes.toString("utf8"), {
      ...source,
      archive_entry: `${inventory.root}/${path}`,
    });
    return {
      iteration: turn.iteration,
      path,
      atif: ingested.atif,
      provenance: ingested.provenance,
    };
  });

  const callCounts = new Map<string, number>();
  for (const { atif } of trajectories) {
    for (const step of atif.steps) {
      for (const call of step.tool_calls ?? []) {
        callCounts.set(
          call.tool_call_id,
          (callCounts.get(call.tool_call_id) ?? 0) + 1,
        );
      }
    }
  }
  const callIdMaps = new Map<number, Map<string, string>>();
  const canonicalCallIds = new Set<string>();
  for (const { iteration, atif } of trajectories) {
    const callIdMap = new Map<string, string>();
    for (const step of atif.steps) {
      for (const call of step.tool_calls ?? []) {
        const canonical = (callCounts.get(call.tool_call_id) ?? 0) > 1
          ? `iteration-${iteration}:${call.tool_call_id}`
          : call.tool_call_id;
        callIdMap.set(call.tool_call_id, canonical);
        canonicalCallIds.add(canonical);
      }
    }
    callIdMaps.set(iteration, callIdMap);
  }

  const steps: ScopeAtif["steps"] = [];
  const stepMappings: AtifProvenance["mappings"][number][] = [];
  const supplementalMappings: AtifSourceMapping[] = [];
  let nextStepId = 1;
  const archiveSources = deriveAvailableSources(archive, run, taxonomy);
  const sourceMap = new Map(archiveSources.map(source => [source.id, source]));
  const manifestSource = {
    ...source,
    archive_entry: `${inventory.root}/run.yaml`,
  };
  const sourceOrigins = new Map<string, AtifSourceMapping>(
    archiveSources.map(source => [source.id, {
      normalized_prefix: "$",
      original_prefix: "$",
      source: manifestSource,
      generated_by: "scope-archive-stitching",
      mode: "anchor",
    }]),
  );
  const firstAgentOrigin = originalAtifPath(
    trajectories[0].provenance,
    "$.agent",
  );
  stepMappings.push({
    normalized_prefix: "$.agent",
    original_prefix: firstAgentOrigin.path,
    ...(firstAgentOrigin.source
      ? { source: firstAgentOrigin.source }
      : {}),
    generated_by: "scope-archive-stitching",
  });

  for (const { iteration, path, atif, provenance } of trajectories) {
    for (const [sourceIndex, availableSource] of (
      atif.extra?.scope?.available_sources ?? []
    ).entries()) {
      const existing = sourceMap.get(availableSource.id);
      if (existing && (
        existing.label !== availableSource.label ||
        existing.surface_id !== availableSource.surface_id
      )) {
        throw new Error(
          `Source '${availableSource.id}' conflicts between run.yaml and ${path}`,
        );
      }
      if (!existing) {
        const origin = originalAtifPath(
          provenance,
          `$.extra.scope.available_sources[${sourceIndex}]`,
        );
        sourceOrigins.set(availableSource.id, {
          normalized_prefix: "$",
          original_prefix: origin.path,
          ...(origin.source ? { source: origin.source } : {}),
          ...(origin.generated_by
            ? { generated_by: origin.generated_by }
            : {}),
        });
      }
      sourceMap.set(availableSource.id, availableSource);
    }

    const callIdMap = callIdMaps.get(iteration)!;
    const toolCallPath = `iteration-${iteration}.tool-calls.jsonl`;
    const extraCalls = inventory.files.has(toolCallPath)
      ? parseToolCallJsonl(
        inventory.files.get(toolCallPath)!,
        toolCallPath,
        {
          ...source,
          archive_entry: `${inventory.root}/${toolCallPath}`,
        },
      )
      : new Map();

    for (const [originalStepIndex, originalStep] of atif.steps.entries()) {
      const step = originalStep;
      const originalStepId = step.step_id;
      step.step_id = nextStepId++;
      const normalizedStepIndex = steps.length;
      stepMappings.push({
        normalized_prefix: `$.steps[${normalizedStepIndex}]`,
        original_prefix:
          `${provenance.container_prefix}.steps[${originalStepIndex}]`,
        source: provenance.source,
        generated_by: "scope-archive-stitching",
      });
      const sourceStepPrefix = `$.steps[${originalStepIndex}]`;
      const targetStepPrefix = `$.steps[${normalizedStepIndex}]`;
      for (const mapping of provenance.mappings) {
        if (
          mapping.normalized_prefix !== sourceStepPrefix &&
          !mapping.normalized_prefix.startsWith(`${sourceStepPrefix}.`) &&
          !mapping.normalized_prefix.startsWith(`${sourceStepPrefix}[`)
        ) continue;
        stepMappings.push({
          ...mapping,
          normalized_prefix:
            `${targetStepPrefix}${
              mapping.normalized_prefix.slice(sourceStepPrefix.length)
            }`,
        });
      }
      step.extra = {
        ...(step.extra ?? {}),
        scope: {
          ...(step.extra?.scope ?? {}),
          origin: { iteration, step_id: originalStepId },
        },
      };

      for (const [callIndex, call] of (
        step.tool_calls ?? []
      ).entries()) {
        const originalCallId = call.tool_call_id;
        call.tool_call_id = callIdMap.get(originalCallId)!;
        const supplementalEntry = extraCalls.get(originalCallId);
        const supplemental = supplementalEntry?.call;
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
        if (supplementalEntry) {
          if (supplemental?.response !== undefined) {
            supplementalMappings.push({
              normalized_prefix:
                `$.steps[${normalizedStepIndex}].tool_calls[${callIndex}].extra.scope.response`,
              original_prefix: "$.response",
              source: {
                ...source,
                archive_entry: `${inventory.root}/${toolCallPath}`,
                jsonl_line: supplementalEntry.line,
                json_path_prefix: "$",
              },
            });
          }
          extraCalls.delete(originalCallId);
        }
      }

      for (const result of step.observation?.results ?? []) {
        if (result.source_call_id) {
          const originalSourceCallId = result.source_call_id;
          const rewritten = canonicalCallIds.has(originalSourceCallId)
            ? originalSourceCallId
            : callIdMap.get(originalSourceCallId);
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

    // Scope exports can retain transport-level calls omitted from the normalized
    // ATIF trajectory. Only matching calls enrich ATIF; unrelated rows are
    // intentionally ignored rather than becoming synthetic trajectory steps.
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
  const agent = trajectories[0].atif.agent;
  const scenario = archive.scenario;
  const availableSources = [...sourceMap.values()];
  for (const [sourceIndex, availableSource] of availableSources.entries()) {
    const origin = sourceOrigins.get(availableSource.id);
    if (!origin) continue;
    stepMappings.push({
      ...origin,
      normalized_prefix:
        `$.extra.scope.available_sources[${sourceIndex}]`,
    });
  }
  stepMappings.push(
    {
      normalized_prefix: "$.extra.scope.trajectory_state",
      original_prefix: "$.run.status",
      source: manifestSource,
      generated_by: "scope-archive-stitching",
      mode: "anchor",
    },
    {
      normalized_prefix: "$.extra.scope.run.request_id",
      original_prefix: "$._id",
      source: manifestSource,
      generated_by: "scope-archive-stitching",
    },
    {
      normalized_prefix: "$.extra.scope.run.id",
      original_prefix: "$.run._id",
      source: manifestSource,
      generated_by: "scope-archive-stitching",
    },
  );
  if (scenario.task) {
    stepMappings.push({
      normalized_prefix: "$.extra.scope.task",
      original_prefix: "$.scenario.task",
      source: manifestSource,
      generated_by: "scope-archive-stitching",
    });
  }
  const normalized = ingestAtif({
    schema_version: "ATIF-v1.8",
    session_id: `${archive._id}:${run._id}`,
    agent: {
        ...agent,
        name: agent.name || archive.workerType || "scope-run",
    },
    steps,
    extra: {
      scope: {
        schema_version: SCOPE_ATIF_EXTENSION_VERSION,
        trajectory_state: trajectoryState,
        ...(scenario.task ? { task: scenario.task } : {}),
        run: {
          request_id: archive._id,
          id: run._id,
          ...(scenario._id ?? scenario.id
            ? { scenario_id: scenario._id ?? scenario.id }
            : {}),
          ...(scenario.name
            ? { scenario_label: scenario.name }
            : {}),
          ...(archive.profileId ?? archive.profileVersionId
            ? {
              profile_id:
                archive.profileId ?? archive.profileVersionId,
            }
            : {}),
        },
        available_sources: availableSources,
        configured_capabilities: {
          ...(archive.skillRevisions
            ? { skills: archive.skillRevisions }
            : {}),
          ...(archive.mcpServers
            ? { mcp_servers: archive.mcpServers }
            : {}),
          ...(archive.extensions
            ? { extensions: archive.extensions }
            : {}),
          ...(archive.resources
            ? {
              resources: archive.resources.map(resource =>
                typeof resource === "string"
                  ? resource
                  : resource.slug ?? resource.ref ?? "",
              ).filter(Boolean),
            }
            : {}),
        },
        actual_outcomes: {
          ...(run.mcpRegistered !== undefined
            ? { mcp_registered: run.mcpRegistered }
            : {}),
          ...(run.resources ? { resources: run.resources } : {}),
        },
      },
    },
  }, {
    ...source,
    archive_entry: `${inventory.root}/run.yaml`,
  }, [...stepMappings, ...supplementalMappings]);
  normalized.provenance = {
    ...normalized.provenance,
    components: trajectories.map(trajectory => ({
      source: trajectory.provenance.source,
      source_version: trajectory.provenance.source_version,
      upcasters: trajectory.provenance.upcasters,
    })),
  };
  validateScopeAtif(
    normalized.atif,
    taxonomy,
    normalized.provenance,
  );
  return normalized;
}

/** Back-compatible archive-root normalizer returning evidence only. */
export async function normalizeScopeArchiveRoot(
  inventory: ScopeArchiveRoot,
  taxonomy: NormalizedTaxonomy,
): Promise<ScopeAtif> {
  return (await normalizeScopeArchiveRootResult(inventory, taxonomy)).atif;
}

function archiveLimits(options: ArchiveLimits): Required<ArchiveLimits> {
  return {
    maxCompressedBytes: options.maxCompressedBytes ?? 16 * 1024 * 1024 * 1024,
    maxStreamedBytes: options.maxStreamedBytes ?? 32 * 1024 * 1024 * 1024,
    maxRetainedBytes: options.maxRetainedBytes ?? 128 * 1024 * 1024,
    maxEntries: options.maxEntries ?? 10_000,
    maxPathDepth: options.maxPathDepth ?? 3,
  };
}

/** Streams and normalizes every run root in deterministic archive order. */
export async function normalizeScopeArchiveRoots(
  archiveSource: ArchiveSource,
  taxonomy: NormalizedTaxonomy,
  options: ArchiveLimits = {},
  scanOptions: ArchiveScanOptions = {},
  sourceDescriptor: AtifSourceDescriptor = {},
): Promise<Array<{
  root: ScopeArchiveRoot;
  atif?: ScopeAtif;
  provenance?: AtifProvenance;
  error?: Error;
}>> {
  const limits = archiveLimits(options);
  if (
    Buffer.isBuffer(archiveSource) &&
    archiveSource.length > limits.maxCompressedBytes
  ) {
    throw new Error(`Archive exceeds compressed byte limit ${limits.maxCompressedBytes}`);
  }
  const scan = await scanScopeArchive(archiveSource, limits, scanOptions);
  return Promise.all(scan.roots.map(async root => {
    try {
      const result = await normalizeScopeArchiveRootResult(
        root,
        taxonomy,
        sourceDescriptor,
      );
      return {
        root,
        atif: result.atif,
        provenance: result.provenance,
      };
    } catch (error) {
      return {
        root,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }));
}

/** Back-compatible single-root archive normalizer. */
export async function normalizeScopeArchive(
  compressed: Buffer,
  taxonomy: NormalizedTaxonomy,
  options: ArchiveLimits = {},
): Promise<ScopeAtif> {
  const roots = await normalizeScopeArchiveRoots(compressed, taxonomy, options);
  if (roots.length !== 1) {
    throw new Error("Scope archive must contain exactly one run root");
  }
  if (roots[0].error || !roots[0].atif) throw roots[0].error;
  return roots[0].atif;
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
  return (await loadAtifInputResult(location, taxonomy)).atif;
}

/** Loads one plain/archive input together with original-source provenance. */
export async function loadAtifInputResult(
  location: string,
  taxonomy: NormalizedTaxonomy,
): Promise<AtifIngestionResult<ScopeAtif> & {
  inputKind: AtifInputKind;
  archiveRoot?: string;
}> {
  const bytes = await loadBytes(location, { maxBytes: 32 * 1024 * 1024 });
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const roots = await normalizeScopeArchiveRoots(
      bytes,
      taxonomy,
      {},
      {},
      { file: location },
    );
    if (roots.length !== 1) {
      throw new Error("Scope archive must contain exactly one run root");
    }
    if (roots[0].error || !roots[0].atif || !roots[0].provenance) {
      throw roots[0].error;
    }
    return {
      atif: roots[0].atif,
      provenance: roots[0].provenance,
      inputKind: "archive",
      archiveRoot: roots[0].root.root,
    };
  }
  const result = ingestAtifJson(bytes.toString("utf8"), { file: location });
  validateScopeAtif(result.atif, taxonomy, result.provenance);
  return {
    ...result,
    inputKind: "plain",
  };
}

/** Loads plain ATIF or every run root from one Scope archive. */
export async function loadAtifInputs(
  location: string,
  taxonomy: NormalizedTaxonomy,
  options: ArchiveLimits = {},
  scanOptions: Omit<ArchiveScanOptions, "compressedTotalBytes"> = {},
): Promise<LoadedAtifInput[]> {
  if (!/^https?:\/\//i.test(location)) {
    const fileStats = await stat(location);
    const limits = archiveLimits(options);
    if (fileStats.size > limits.maxCompressedBytes) {
      throw new Error(`Archive exceeds compressed byte limit ${limits.maxCompressedBytes}`);
    }
    const file = await import("node:fs/promises").then(fs => fs.open(location, "r"));
    const magic = Buffer.alloc(2);
    try {
      await file.read(magic, 0, 2, 0);
    } finally {
      await file.close();
    }
    if (magic[0] === 0x1f && magic[1] === 0x8b) {
      const roots = await normalizeScopeArchiveRoots(
        createReadStream(location),
        taxonomy,
        options,
        {
          ...scanOptions,
          compressedTotalBytes: fileStats.size,
        },
        { file: location },
      );
      return roots.map(result => ({
        inputKind: "archive",
        root: result.root.root,
        fingerprint: result.root.fingerprint,
        ...(result.root.requestId ? { requestId: result.root.requestId } : {}),
        ...(result.root.runId ? { runId: result.root.runId } : {}),
        ...(result.atif ? { atif: result.atif } : {}),
        ...(result.provenance
          ? { provenance: result.provenance }
          : {}),
        ...(result.error ? { error: result.error } : {}),
      }));
    }
  }

  const loaded = await loadAtifInputResult(location, taxonomy);
  const atif = loaded.atif;
  return [{
    inputKind: loaded.inputKind,
    root: loaded.archiveRoot ?? "input",
    fingerprint: createHash("sha256")
      .update(JSON.stringify(atif))
      .digest("hex"),
    atif,
    provenance: loaded.provenance,
    requestId: atif.extra?.scope?.run?.request_id,
    runId: atif.extra?.scope?.run?.id,
  }];
}
