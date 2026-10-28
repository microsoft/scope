// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  glob,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  buildEvidenceIndex,
  parseDefiniteJsonPath,
  validateAssessment,
} from "./evidence.js";
import {
  evaluationSchema,
  type Evaluation,
  type SucceededEvaluation,
} from "./engine.js";
import { createInputIdentity } from "./input-identity.js";
import type { InputIdentity } from "./assessment.js";
import type { InputIdentityContext } from "./input-identity.js";
import {
  atifInputOriginKey,
  loadAtifInputs,
  createAtifInputOrigin,
  type AtifInputOrigin,
} from "./archive.js";
import {
  AtifIngestionError,
  originalAtifPath,
  type AtifIngestionDiagnostic,
  type AtifProvenance,
} from "./atif/index.js";
import type { ScopeAtif } from "./scope-atif.js";
import type { NormalizedTaxonomy } from "./taxonomy.js";

export const taxonomyRunResultSchema = z.object({
  run: z.object({
    id: z.string().min(1),
    scenario: z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      task: z.string().optional(),
    }).strict(),
    profile: z.object({
      id: z.string().min(1),
      label: z.string().min(1),
    }).strict(),
  }).strict(),
  results: z.array(evaluationSchema),
  metadata: z.unknown().optional(),
}).strict();

const readoutErrorSchema = z.object({
  schema_version: z.literal("scope/taxonome-run-error/v1"),
  root: z.string().min(1),
  request_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  stage: z.enum(["parse", "evaluation", "cleanup", "cancelled"]),
  error: z.string().min(1),
  atif_provenance: z.unknown().optional(),
  input_origin: z.object({
    selected_input: z.string().min(1),
    archive_root: z.string().min(1).optional(),
  }).strict().optional(),
  atif_diagnostic: z.object({
    code: z.string().min(1),
    stage: z.enum([
      "decoding",
      "container",
      "version",
      "source_validation",
      "upcasting",
      "target_validation",
      "scope_normalization",
      "result_validation",
    ]),
    message: z.string().min(1),
    file: z.string().optional(),
    archive_entry: z.string().optional(),
    jsonl_line: z.number().int().positive().optional(),
    original_path: z.string().min(1),
    normalized_path: z.string().optional(),
    source_version: z.enum([
      "ATIF-v1.6",
      "ATIF-v1.7",
      "ATIF-v1.8",
    ]).optional(),
    target_version: z.enum([
      "ATIF-v1.6",
      "ATIF-v1.7",
      "ATIF-v1.8",
    ]).optional(),
    upcaster: z.string().optional(),
    generated_by: z.string().optional(),
  }).strict().optional(),
}).strict();

export type ReadoutRunV2 = z.infer<typeof taxonomyRunResultSchema>;
export type ReadoutErrorV1 = z.infer<typeof readoutErrorSchema>;

export interface ValidReadoutInput {
  kind?: "valid";
  atif: ScopeAtif;
  atif_provenance?: AtifProvenance;
  source: string;
  context?: InputIdentityContext;
  identity?: InputIdentity;
  origin?: AtifInputOrigin;
}

export interface InvalidReadoutInput {
  kind: "invalid";
  source: string;
  root: string;
  requestId?: string;
  runId?: string;
  error: string;
  atif_diagnostic?: AtifIngestionDiagnostic;
  origin?: AtifInputOrigin;
}

export type ReadoutInput = ValidReadoutInput | InvalidReadoutInput;

const readoutRunSchema = taxonomyRunResultSchema;

const hasGlobMagic = (pattern: string) => /[*?[\]{}]/.test(pattern);

function recognizableResult(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(item => recognizableResult(item));
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    "run" in record ||
    "results" in record ||
    (
      typeof record.schema_version === "string" &&
      record.schema_version.startsWith("scope/taxonome-run-error/")
    )
  );
}

async function readResultFile(
  path: string,
  requireRecognizable: boolean,
): Promise<unknown | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Readout result '${path}' is malformed JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!recognizableResult(value)) {
    if (requireRecognizable) {
      throw new Error(
        `Readout result '${path}' is not a recognized Taxonome result or error record`,
      );
    }
    return undefined;
  }
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (
      !taxonomyRunResultSchema.safeParse(item).success &&
      !readoutErrorSchema.safeParse(item).success
    ) {
      throw new Error(
        `Readout result '${path}' uses a stale or invalid Taxonome result shape; recompute it with taxonome run --force.`,
      );
    }
  }
  return value;
}

/** Resolves explicit files, directories, and quoted result globs deterministically. */
export async function resolveReadoutFiles(
  patterns: readonly string[],
  cwd = process.cwd(),
): Promise<string[]> {
  if (!patterns.length) throw new Error("At least one readout input is required");
  const resolved = new Set<string>();
  for (const pattern of patterns) {
    const matches: string[] = [];
    if (hasGlobMagic(pattern)) {
      for await (const match of glob(pattern, { cwd })) {
        const path = isAbsolute(match) ? match : resolve(cwd, match);
        if ((await stat(path)).isFile()) matches.push(path);
      }
    } else {
      const path = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
      let details;
      try {
        details = await stat(path);
      } catch {
        details = undefined;
      }
      if (details?.isFile()) {
        matches.push(path);
      } else if (details?.isDirectory()) {
        const children = (await readdir(path))
          .filter(name => name.endsWith(".json"))
          .map(name => resolve(path, name))
          .sort();
        for (const child of children) {
          const value = await readResultFile(child, false);
          if (value !== undefined) matches.push(child);
        }
      }
    }
    if (!matches.length) {
      throw new Error(`Readout input '${pattern}' matched no recognized files`);
    }
    matches.sort();
    for (const match of matches) resolved.add(match);
  }
  return [...resolved].sort();
}

/** Loads result collections while preserving current single-array input support. */
export async function loadReadoutCollection(
  patterns: readonly string[],
  cwd = process.cwd(),
): Promise<unknown[]> {
  const files = await resolveReadoutFiles(patterns, cwd);
  const values: unknown[] = [];
  for (const file of files) {
    const value = await readResultFile(file, true);
    if (Array.isArray(value)) values.push(...value);
    else values.push(value);
  }
  return values;
}

/** Resolves repeatable plain-ATIF or local Scope-archive evidence selections. */
export async function loadReadoutInputs(
  patterns: readonly string[],
  taxonomy: NormalizedTaxonomy,
  cwd = process.cwd(),
): Promise<ReadoutInput[]> {
  if (!patterns.length) {
    throw new Error("At least one --inputs pattern is required");
  }
  const files = new Set<string>();
  for (const pattern of patterns) {
    const matches: string[] = [];
    if (hasGlobMagic(pattern)) {
      for await (const match of glob(pattern, { cwd })) {
        const path = isAbsolute(match) ? match : resolve(cwd, match);
        if ((await stat(path)).isFile()) matches.push(path);
      }
    } else {
      const path = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
      try {
        if ((await stat(path)).isFile()) matches.push(path);
      } catch {
        // Explicit unavailable paths are retained as invalid evidence roots.
      }
      if (!matches.length) matches.push(path);
    }
    if (!matches.length) {
      throw new Error(`Readout evidence pattern '${pattern}' matched no files`);
    }
    matches.sort();
    for (const match of matches) files.add(match);
  }

  const inputs: ReadoutInput[] = [];
  for (const file of [...files].sort()) {
    let canonicalFile = file;
    try {
      canonicalFile = await realpath(file);
    } catch {
      // Stable lexical locator is authoritative for unavailable evidence.
    }
    let loaded;
    try {
      loaded = await loadAtifInputs(file, taxonomy);
    } catch (error) {
      inputs.push({
        kind: "invalid",
        source: `${file}#input`,
        root: "input",
        error: error instanceof Error ? error.message : String(error),
        origin: { selected_input: canonicalFile },
        ...(error instanceof AtifIngestionError
          ? {
            atif_diagnostic: structuredClone(error.diagnostic),
          }
          : {}),
      });
      continue;
    }
    for (const source of loaded) {
      const origin = createAtifInputOrigin(canonicalFile, source);
      if (source.error) {
        inputs.push({
          kind: "invalid",
          source: file,
          root: source.root,
          ...(source.requestId ? { requestId: source.requestId } : {}),
          ...(source.runId ? { runId: source.runId } : {}),
          error: source.error.message,
          origin,
          ...(source.error instanceof AtifIngestionError
            ? {
              atif_diagnostic: structuredClone(
                source.error.diagnostic,
              ),
            }
            : {}),
        });
        continue;
      }
      if (!source.atif) {
        throw new Error(
          `Readout evidence '${file}' root '${source.root}' has no ATIF`,
        );
      }
      inputs.push({
        kind: "valid",
        atif: source.atif,
        ...(source.provenance
          ? { atif_provenance: source.provenance }
          : {}),
        source: `${file}#${source.root}`,
        origin,
        context: {
          ...(source.inputKind === "archive"
            ? { archiveRoot: source.root }
            : {}),
          requestId: source.requestId,
          runId: source.runId,
        },
        identity: createInputIdentity(source.atif, {
          ...(source.inputKind === "archive"
            ? { archiveRoot: source.root }
            : {}),
          requestId: source.requestId,
          runId: source.runId,
        }),
      });
    }
  }
  return inputs;
}

function sourceAttribution(
  atif: ScopeAtif,
  evaluation: SucceededEvaluation,
  occurrenceIndex: number,
) {
  if (
    evaluation.result.state !== "completed" ||
    evaluation.result.observed !== true
  ) return [];
  const occurrence = evaluation.result.occurrences[occurrenceIndex];
  const evidenceIndex = buildEvidenceIndex(atif);
  const available = new Map(
    (atif.extra?.scope?.available_sources ?? []).map(source => [
      source.id,
      source,
    ]),
  );
  const sources = new Map<string, Record<string, unknown>>();
  for (const reference of occurrence.evidence) {
    const resolution = evidenceIndex.get(
      parseDefiniteJsonPath(reference.path).canonical,
    );
    const node = resolution?.node as Record<string, unknown> | undefined;
    let sourceId: string | undefined;
    if (resolution?.type === "scope.discovery") {
      sourceId = typeof node?.source_id === "string"
        ? node.source_id
        : undefined;
    } else if (resolution?.callPath) {
      const call = evidenceIndex.get(resolution.callPath)?.node as {
        extra?: { scope?: { source_id?: string } };
      } | undefined;
      sourceId = call?.extra?.scope?.source_id;
    }
    const source = sourceId ? available.get(sourceId) : undefined;
    if (source) sources.set(source.id, source);
  }
  return [...sources.values()];
}

/** Builds dynamic behavior/source frequencies after exact-input revalidation. */
export function buildReadoutV2(
  value: unknown,
  taxonomy: NormalizedTaxonomy,
  inputs: readonly ReadoutInput[],
) {
  const values = Array.isArray(value) ? value : [value];
  const runs: ReadoutRunV2[] = [];
  const failedRuns: ReadoutErrorV1[] = [];
  for (const item of values) {
    const failed = readoutErrorSchema.safeParse(item);
    if (failed.success) {
      failedRuns.push(failed.data);
      continue;
    }
    runs.push(readoutRunSchema.parse(item));
  }

  const inputsByKey = new Map<string, ValidReadoutInput>();
  const inputsByHash = new Map<string, ValidReadoutInput[]>();
  for (const input of inputs) {
    if (input.kind === "invalid") continue;
    const recomputed = createInputIdentity(input.atif, input.context);
    if (
      input.identity &&
      (
        input.identity.normalization !== recomputed.normalization ||
        input.identity.sha256 !== recomputed.sha256 ||
        ([
          "trajectory_id",
          "session_id",
          "request_id",
          "run_id",
          "archive_root",
        ] as const).some(field =>
          input.identity?.[field] !== undefined &&
          input.identity[field] !== recomputed[field]
        )
      )
    ) {
      throw new Error(
        `Readout evidence '${input.source}' supplied identity metadata that does not match its normalized ATIF`,
      );
    }
    const hash = recomputed.sha256;
    const sameHash = inputsByHash.get(hash) ?? [];
    sameHash.push(input);
    inputsByHash.set(hash, sameHash);
    const key = input.origin
      ? `${atifInputOriginKey(input.origin)}\0${hash}`
      : hash;
    const existing = inputsByKey.get(key);
    if (existing && existing.source !== input.source) {
      throw new Error(
        `Readout evidence identity '${key}' is duplicated between '${existing.source}' and '${input.source}'`,
      );
    }
    inputsByKey.set(key, input);
  }

  for (const input of inputs) {
    if (input.kind !== "invalid") continue;
    const represented = failedRuns.some(failure =>
      failure.stage === "parse" &&
      failure.root === input.root &&
      (
        failure.input_origin === undefined ||
        input.origin === undefined ||
        isDeepStrictEqual(failure.input_origin, input.origin)
      ) &&
      (
        input.requestId === undefined ||
        failure.request_id === input.requestId
      ) &&
      (
        input.runId === undefined ||
        failure.run_id === input.runId
      )
    );
    if (!represented) {
      throw new Error(
        `Readout evidence '${input.source}' root '${input.root}' is invalid but no matching persisted Taxonome error record was supplied: ${input.error}`,
      );
    }
  }

  const runIds = new Set<string>();
  const groups = new Map<string, Array<{
    run: ReadoutRunV2;
    inputs: Map<string, ScopeAtif>;
  }>>();
  for (const run of runs) {
    if (runIds.has(run.run.id)) {
      throw new Error(`Duplicate readout run '${run.run.id}'`);
    }
    runIds.add(run.run.id);
    if (new Set(run.results.map(result => result.element.id)).size !== run.results.length) {
      throw new Error(`Run '${run.run.id}' contains duplicate element results`);
    }
    const matchedInputs = new Map<string, ScopeAtif>();
    for (const evaluation of run.results) {
      if (evaluation.taxonomy.digest !== taxonomy.digest) {
        throw new Error(
          `Readout result taxonomy digest '${evaluation.taxonomy.digest}' does not match '${taxonomy.digest}'`,
        );
      }
      const element = taxonomy.elementById.get(evaluation.element.id);
      if (!element) {
        throw new Error(
          `Readout result references unknown element '${evaluation.element.id}'`,
        );
      }
      const metadata = run.metadata as Record<string, unknown> | undefined;
      const sourceMetadata = metadata?.source as
        | Record<string, unknown>
        | undefined;
      const originResult = z.object({
        selected_input: z.string().min(1),
        archive_root: z.string().min(1).optional(),
      }).strict().safeParse(sourceMetadata?.input_origin);
      const origin = originResult.success
        ? originResult.data
        : undefined;
      const candidates = inputsByHash.get(evaluation.input.sha256) ?? [];
      const matched = origin
        ? inputsByKey.get(
          `${atifInputOriginKey(origin)}\0${evaluation.input.sha256}`,
        )
        : candidates.length === 1 ? candidates[0] : undefined;
      if (!matched) {
        if (!origin && candidates.length > 1) {
          throw new Error(
            `Readout result input '${evaluation.input.sha256}' is ambiguous across source origins`,
          );
        }
        throw new Error(
          `Readout result input '${evaluation.input.sha256}' has no matching --inputs evidence`,
        );
      }
      const matchedIdentity = createInputIdentity(
        matched.atif,
        matched.context,
      );
      if (evaluation.input.normalization !== matchedIdentity.normalization) {
        throw new Error("Readout result normalization contract mismatch");
      }
      for (const field of [
        "trajectory_id",
        "session_id",
        "request_id",
        "run_id",
        "archive_root",
      ] as const) {
        if (
          evaluation.input[field] !== undefined &&
          evaluation.input[field] !== matchedIdentity[field]
        ) {
          throw new Error(
            `Readout result input identity field '${field}' does not match --inputs evidence`,
          );
        }
      }
      matchedInputs.set(evaluation.element.id, matched.atif);
      if (evaluation.status === "succeeded") {
        const validation = validateAssessment(
          evaluation.result,
          element.output,
          matched.atif,
        );
        if (!validation.assessment) {
          const diagnosticSummary = validation.diagnostics.map(item =>
            `${item.code}${
              item.evidence_path
                ? ` at ${item.evidence_path}`
                : ""
            }`
          ).join(", ");
          const evidenceDiagnostic = validation.diagnostics.find(
            item => item.evidence_path,
          );
          if (evidenceDiagnostic?.evidence_path &&
            matched.atif_provenance) {
            let original: ReturnType<typeof originalAtifPath> = {
              path: matched.atif_provenance.container_prefix,
              source: matched.atif_provenance.source,
            };
            if (evidenceDiagnostic.code !== "invalid_jsonpath") {
              try {
                original = originalAtifPath(
                  matched.atif_provenance,
                  evidenceDiagnostic.evidence_path,
                );
              } catch {
                // Invalid result paths retain source context without being parsed.
              }
            }
            throw new AtifIngestionError({
              code: "atif_readout_evidence_mismatch",
              stage: "result_validation",
              message:
                `Readout result '${run.run.id}/${element.id}' has invalid evidence: ` +
                diagnosticSummary,
              ...(original.source ??
                matched.atif_provenance.source),
              original_path: original.path,
              normalized_path: evidenceDiagnostic.evidence_path,
              source_version:
                matched.atif_provenance.source_version,
              target_version: "ATIF-v1.8",
              ...(original.generated_by
                ? { generated_by: original.generated_by }
                : {}),
            });
          }
          throw new Error(
            `Readout result '${run.run.id}/${element.id}' has invalid evidence: ` +
            diagnosticSummary,
          );
        }
      }
    }
    const key = JSON.stringify([run.run.scenario.id, run.run.profile.id]);
    const group = groups.get(key) ?? [];
    group.push({ run, inputs: matchedInputs });
    groups.set(key, group);
  }

  return {
    schema_version: "scope/taxonomy-readout/v1",
    taxonomy_digest: taxonomy.digest,
    failed_runs: failedRuns,
    groups: [...groups.values()].map(group => ({
      scenario: group[0].run.run.scenario,
      profile: group[0].run.run.profile,
      behaviors: taxonomy.elements.map(element => {
        const coverage = {
          total: group.length,
          assessed: 0,
          negative: 0,
          unknown: 0,
          inapplicable: 0,
          error: 0,
          missing: 0,
        };
        const sourceCounts = new Map<string, {
          source: Record<string, unknown>;
          runs: Set<string>;
          occurrences: number;
          evidence: unknown[];
        }>();
        let distinctRuns = 0;
        let occurrenceCount = 0;

        for (const item of group) {
          const evaluation = item.run.results.find(result =>
            result.element.id === element.id
          );
          if (!evaluation) {
            coverage.unknown++;
            coverage.missing++;
            continue;
          }
          if (evaluation.status === "failed") {
            coverage.error++;
            continue;
          }
          const result = evaluation.result;
          if (!("observed" in result)) {
            if (result.state === "indeterminate") coverage.unknown++;
            else coverage.inapplicable++;
            continue;
          }
          coverage.assessed++;
          if (!result.observed) {
            coverage.negative++;
            continue;
          }

          distinctRuns++;
          occurrenceCount += result.occurrences.length;
          const atif = item.inputs.get(element.id)!;
          result.occurrences.forEach((occurrence, occurrenceIndex) => {
            const sources = sourceAttribution(
              atif,
              evaluation,
              occurrenceIndex,
            );
            for (const source of sources) {
              const key = JSON.stringify([
                source.surface_id,
                source.id,
              ]);
              const count = sourceCounts.get(key) ?? {
                source,
                runs: new Set<string>(),
                occurrences: 0,
                evidence: [],
              };
              count.runs.add(item.run.run.id);
              count.occurrences++;
              count.evidence.push({
                run_id: item.run.run.id,
                occurrence: occurrenceIndex,
                references: occurrence.evidence,
              });
              sourceCounts.set(key, count);
            }
          });
        }

        return {
          element_id: element.id,
          label: element.label,
          ...(element.category_id
            ? { category_id: element.category_id }
            : {}),
          coverage,
          distinct_runs: distinctRuns,
          occurrences: occurrenceCount,
          sources: [...sourceCounts.values()].map(count => ({
            source: count.source,
            distinct_runs: count.runs.size,
            occurrences: count.occurrences,
            evidence: count.evidence,
          })),
        };
      }),
    })),
  };
}

/** Renders deterministic readout counts and reference drill-downs as Markdown. */
export function readoutMarkdownV2(
  report: ReturnType<typeof buildReadoutV2>,
): string {
  const lines = ["# Taxonome behavior preview", ""];
  for (const group of report.groups) {
    lines.push(
      `## ${group.scenario.label} / ${group.profile.label}`,
      "",
      "| Behavior / source | Distinct runs / total | Occurrences | Assessed | Negative | Unknown | Inapplicable | Error |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const behavior of group.behaviors) {
      const coverage = behavior.coverage;
      lines.push(
        `| ${behavior.label} | ${behavior.distinct_runs}/${coverage.total} | ${behavior.occurrences} | ${coverage.assessed} | ${coverage.negative} | ${coverage.unknown} | ${coverage.inapplicable} | ${coverage.error} |`,
      );
      for (const source of behavior.sources) {
        const label = String(source.source.label ?? "(unattributed)")
          .replaceAll("|", "\\|")
          .replaceAll("\n", " ");
        lines.push(
          `| ${behavior.label} / ${label} | ${source.distinct_runs}/${coverage.total} | ${source.occurrences} | ${coverage.assessed} | ${coverage.negative} | ${coverage.unknown} | ${coverage.inapplicable} | ${coverage.error} |`,
        );
      }
    }
    lines.push("");
    for (const behavior of group.behaviors) {
      if (!behavior.sources.length) continue;
      lines.push(
        `### ${behavior.label} evidence`,
        "",
        "```json",
        JSON.stringify(
          behavior.sources.flatMap(source => source.evidence),
          null,
          2,
        ),
        "```",
        "",
      );
    }
  }
  if (report.failed_runs.length) {
    lines.push("## Failed runs", "");
    for (const failure of report.failed_runs) {
      const identity = failure.run_id ?? failure.request_id ?? failure.root;
      lines.push(`- \`${identity}\` (${failure.stage}): ${failure.error}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
