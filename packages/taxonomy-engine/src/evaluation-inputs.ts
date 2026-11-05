// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  glob,
  readFile,
  stat,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  assessmentSchema,
  type Assessment,
} from "./assessment.js";
import type { Evaluation } from "./engine.js";
import {
  validateScopeAtif,
  type ScopeAtif,
} from "./scope-atif.js";
import {
  ingestAtif,
  type AtifProvenance,
} from "./atif/index.js";
import type { NormalizedTaxonomy } from "./taxonomy.js";

const evaluationInputSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  originating_run: z.string().min(1),
  split: z.enum(["train", "validation", "test"]),
  provenance: z.string().min(1),
  elements: z.array(z.string().min(1)).min(1),
  atif: z.unknown(),
}).strict();

export const groundTruthExpectationSchema = assessmentSchema;

const groundTruthFileSchema = z.record(
  z.record(groundTruthExpectationSchema),
);

/** One reviewed evaluation input with normalized ATIF and source location. */
export interface EvaluationInput
  extends Omit<z.infer<typeof evaluationInputSchema>, "atif"> {
  /** Validated ATIF carrying run facts in `extra.scope`. */
  atif: ScopeAtif;
  /** Original JSONL source mapping retained outside evidence. */
  atif_provenance: AtifProvenance;
  /** Repository/cwd-relative JSONL filename used for diagnostics/progress. */
  source_file: string;
  /** One-based JSONL line number. */
  source_line: number;
}

/** Reviewed expectations keyed by input ID then element ID. */
export type GroundTruth = z.infer<typeof groundTruthFileSchema>;
export type GroundTruthExpectation = z.infer<
  typeof groundTruthExpectationSchema
>;

/** Merged ground truth plus source locations for conflict diagnostics. */
export interface LoadedGroundTruth {
  /** Expectations joined by stable input and element IDs. */
  values: GroundTruth;
  /** Deterministically ordered matched files. */
  files: string[];
  /** Source filename for each `<input-id>/<element-id>` pair. */
  source_by_pair: Map<string, string>;
}

/** Fully joined evaluation data loaded from repeatable patterns. */
export interface EvaluationData {
  /** Deterministically ordered, globally unique inputs. */
  inputs: EvaluationInput[];
  /** Merged reviewed ground truth. */
  ground_truth: LoadedGroundTruth;
}

const hasGlobMagic = (pattern: string) => /[*?[\]{}]/.test(pattern);

/** Normalizes one matched path for stable user-facing diagnostics. */
function displayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  return relativePath && !relativePath.startsWith("..")
    ? relativePath
    : path;
}

/**
 * Resolves quoted glob patterns or explicit files, sorting and deduplicating.
 *
 * @param patterns - Repeatable caller patterns.
 * @param cwd - Invocation directory used for relative patterns and diagnostics.
 * @param label - Human-readable input kind used in unmatched-pattern errors.
 */
export async function resolveEvaluationFiles(
  patterns: readonly string[],
  cwd: string,
  label: "input" | "ground-truth",
): Promise<string[]> {
  if (!patterns.length) {
    throw new Error(`At least one --${label === "input" ? "inputs" : "ground-truth"} pattern is required`);
  }

  const resolved = new Set<string>();
  for (const pattern of patterns) {
    const matches: string[] = [];
    if (!hasGlobMagic(pattern)) {
      const path = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
      try {
        if ((await stat(path)).isFile()) matches.push(path);
      } catch {
        // Report through the shared unmatched-pattern error below.
      }
    } else {
      for await (const match of glob(pattern, { cwd })) {
        const path = isAbsolute(match) ? match : resolve(cwd, match);
        if ((await stat(path)).isFile()) matches.push(path);
      }
    }

    if (!matches.length) {
      throw new Error(`${label} pattern '${pattern}' matched no files`);
    }
    matches.sort((left, right) => left.localeCompare(right));
    for (const match of matches) resolved.add(match);
  }
  return [...resolved].sort((left, right) => left.localeCompare(right));
}

/** Loads merged JSONL inputs and validates cross-file identities/splits. */
export async function loadEvaluationInputs(
  patterns: readonly string[],
  taxonomy: NormalizedTaxonomy,
  cwd = process.cwd(),
): Promise<EvaluationInput[]> {
  const files = await resolveEvaluationFiles(patterns, cwd, "input");
  const inputs: EvaluationInput[] = [];
  const sourceById = new Map<string, string>();

  for (const file of files) {
    const sourceFile = displayPath(file, cwd);
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Invalid JSON in ${sourceFile}:${index + 1}`);
      }
      const parsed = evaluationInputSchema.parse(raw);
      const previous = sourceById.get(parsed.id);
      if (previous) {
        throw new Error(
          `Duplicate input ID '${parsed.id}' in ${previous} and ${sourceFile}:${index + 1}`,
        );
      }
      sourceById.set(parsed.id, `${sourceFile}:${index + 1}`);

      for (const elementId of parsed.elements) {
        if (!taxonomy.elementById.has(elementId)) {
          throw new Error(
            `Input '${parsed.id}' in ${sourceFile}:${index + 1} selects unknown element '${elementId}'`,
          );
        }
      }
      const ingested = ingestAtif(parsed.atif, {
        file: sourceFile,
        jsonl_line: index + 1,
        json_path_prefix: "$.atif",
      });
      const atif = ingested.atif;
      validateScopeAtif(atif, taxonomy, ingested.provenance);
      inputs.push({
        ...parsed,
        atif,
        atif_provenance: ingested.provenance,
        source_file: sourceFile,
        source_line: index + 1,
      });
    }
  }

  const splitByFamily = new Map<string, string>();
  const splitByRun = new Map<string, string>();
  for (const input of inputs) {
    for (const [map, key] of [
      [splitByFamily, input.family],
      [splitByRun, input.originating_run],
    ] as const) {
      const existing = map.get(key);
      if (existing && existing !== input.split) {
        throw new Error(
          `Originating-run/family leakage between splits at ${input.source_file}:${input.source_line}`,
        );
      }
      map.set(key, input.split);
    }
  }
  return inputs;
}

/** Loads and merges reviewed ground truth by input ID plus element ID. */
export async function loadGroundTruth(
  patterns: readonly string[],
  cwd = process.cwd(),
): Promise<LoadedGroundTruth> {
  const files = await resolveEvaluationFiles(patterns, cwd, "ground-truth");
  const values: GroundTruth = {};
  const sourceByPair = new Map<string, string>();

  for (const file of files) {
    const sourceFile = displayPath(file, cwd);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch {
      throw new Error(`Invalid JSON in ${sourceFile}`);
    }
    const parsed = groundTruthFileSchema.parse(raw);
    for (const [inputId, elements] of Object.entries(parsed)) {
      values[inputId] ??= {};
      for (const [elementId, expectation] of Object.entries(elements)) {
        const pair = `${inputId}/${elementId}`;
        const previous = sourceByPair.get(pair);
        if (previous) {
          throw new Error(
            `Duplicate ground-truth pair '${pair}' in ${previous} and ${sourceFile}`,
          );
        }
        sourceByPair.set(pair, sourceFile);
        values[inputId][elementId] = expectation;
      }
    }
  }
  return {
    values,
    files: files.map(file => displayPath(file, cwd)),
    source_by_pair: sourceByPair,
  };
}

/** Ensures every declared input/element pair has reviewed ground truth. */
export function validateGroundTruthCoverage(
  inputs: readonly EvaluationInput[],
  groundTruth: LoadedGroundTruth,
): void {
  for (const input of inputs) {
    for (const elementId of input.elements) {
      if (!groundTruth.values[input.id]?.[elementId]) {
        throw new Error(
          `Missing ground truth for '${input.id}/${elementId}' declared at ${input.source_file}:${input.source_line}`,
        );
      }
    }
  }
}

/** Loads, merges, and validates inputs plus ground truth by stable IDs. */
export async function loadEvaluationData(
  inputPatterns: readonly string[],
  groundTruthPatterns: readonly string[],
  taxonomy: NormalizedTaxonomy,
  cwd = process.cwd(),
): Promise<EvaluationData> {
  const [inputs, groundTruth] = await Promise.all([
    loadEvaluationInputs(inputPatterns, taxonomy, cwd),
    loadGroundTruth(groundTruthPatterns, cwd),
  ]);
  validateGroundTruthCoverage(inputs, groundTruth);
  return { inputs, ground_truth: groundTruth };
}

/** Checks one dynamic result against a reviewed expectation. */
export function assertObservation(
  actual: Assessment,
  expected: GroundTruthExpectation,
): string[] {
  if (actual.state !== expected.state) {
    return [`state expected ${expected.state}, got ${actual.state}`];
  }
  if (actual.state !== "completed" || expected.state !== "completed") {
    return [];
  }
  if (actual.observed !== expected.observed) {
    return [`observed expected ${expected.observed}`];
  }
  if (!actual.observed || !expected.observed) return [];
  return isDeepStrictEqual(actual.occurrences, expected.occurrences)
    ? []
    : ["Positive occurrence grouping/references do not match reviewed ground truth"];
}

/** Verifies result selection/cardinality and reviewed semantics for one input. */
export function checkEvaluationInput(
  input: EvaluationInput,
  evaluations: readonly Evaluation[],
  groundTruth: GroundTruth,
  selection: readonly string[] = input.elements,
): string[] {
  const errors: string[] = [];
  for (const elementId of selection) {
    const count = evaluations.filter(evaluation =>
      evaluation.element.id === elementId
    ).length;
    if (count !== 1) {
      errors.push(`Expected exactly one result for ${elementId}, got ${count}`);
    }
  }
  for (const evaluation of evaluations) {
    if (!selection.includes(evaluation.element.id)) {
      errors.push(`Unexpected result for ${evaluation.element.id}`);
      continue;
    }
    const expected = groundTruth[input.id]?.[evaluation.element.id];
    if (!expected) {
      throw new Error(
        `Missing ground truth for ${input.id}/${evaluation.element.id}`,
      );
    }
    if (evaluation.status === "failed") {
      errors.push(
        `${evaluation.element.id}: execution failed (${evaluation.error.code}): ${evaluation.error.message}`,
      );
    } else {
      errors.push(
        ...assertObservation(evaluation.result, expected)
          .map(error => `${evaluation.element.id}: ${error}`),
      );
    }
  }
  return errors;
}
