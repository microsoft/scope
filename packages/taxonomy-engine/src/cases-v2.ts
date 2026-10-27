// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Evaluation } from "./engine.js";
import {
  parseScopeAtif,
  validateScopeAtif,
  type ScopeAtif,
} from "./scope-atif.js";
import type { NormalizedTaxonomy } from "./taxonomy.js";

const caseSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  originating_run: z.string().min(1),
  split: z.enum(["train", "validation", "heldout", "unit"]),
  provenance: z.string().min(1),
  elements: z.array(z.string().min(1)).min(1),
  atif: z.unknown(),
}).strict();

export const expectationSchemaV2 = z.object({
  state: z.enum(["completed", "indeterminate", "inapplicable", "error"]),
  observed: z.boolean().optional(),
  occurrences: z.array(z.object({
    source_id: z.string().optional(),
    discovery_turn: z.number().optional(),
    extension_point_contains: z.string().optional(),
    tool_call_id: z.string().optional(),
    related_turns: z.array(z.number()).optional(),
  }).strict()).optional(),
  exact: z.unknown().optional(),
}).strict();

const goldSchema = z.record(z.record(expectationSchemaV2));

/** One v2 case with normalized ATIF and separate provenance/split metadata. */
export interface EvaluationCaseV2
  extends Omit<z.infer<typeof caseSchema>, "atif"> {
  /** Validated ATIF carrying run facts in `extra.scope`. */
  atif: ScopeAtif;
}

/** Reviewed assertions keyed by case ID then element ID. */
export type GoldV2 = z.infer<typeof goldSchema>;
export type ExpectationV2 = z.infer<typeof expectationSchemaV2>;

/** Loads v2 JSONL and validates every ATIF against the selected taxonomy. */
export async function loadCasesV2(
  path: string,
  taxonomy: NormalizedTaxonomy,
): Promise<EvaluationCaseV2[]> {
  const rows = (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => caseSchema.parse(JSON.parse(line) as unknown));

  if (new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error("Duplicate case IDs");
  }
  const splitByFamily = new Map<string, string>();
  const splitByRun = new Map<string, string>();
  for (const row of rows) {
    for (const [map, key] of [
      [splitByFamily, row.family],
      [splitByRun, row.originating_run],
    ] as const) {
      const existing = map.get(key);
      if (existing && existing !== row.split) {
        throw new Error("Originating-run/family leakage between splits");
      }
      map.set(key, row.split);
    }
    for (const id of row.elements) {
      if (!taxonomy.elementById.has(id)) {
        throw new Error(`Case '${row.id}' selects unknown element '${id}'`);
      }
    }
  }

  return rows.map(row => {
    const atif = parseScopeAtif(row.atif);
    validateScopeAtif(atif, taxonomy);
    return { ...row, atif };
  });
}

/** Loads the separate v2 reviewed gold assertions. */
export async function loadGoldV2(path: string): Promise<GoldV2> {
  return goldSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

/** Checks one dynamic result against a reviewed expectation. */
export function assertObservationV2(
  actual: unknown,
  expected: ExpectationV2,
): string[] {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return ["result must be an object"];
  }
  const record = actual as Record<string, unknown>;
  const errors: string[] = [];
  if (record.state !== expected.state) {
    errors.push(`state expected ${expected.state}, got ${String(record.state)}`);
  }
  if (expected.observed !== undefined && record.observed !== expected.observed) {
    errors.push(`observed expected ${expected.observed}`);
  }
  if (expected.exact !== undefined && !isDeepStrictEqual(actual, expected.exact)) {
    errors.push("Exact JSON mismatch");
  }
  if (expected.occurrences) {
    if (!Array.isArray(record.occurrences)) {
      errors.push("Missing positive occurrences");
    } else {
      if (record.occurrences.length !== expected.occurrences.length) {
        errors.push(
          `Occurrence count expected ${expected.occurrences.length}, got ${record.occurrences.length}`,
        );
      }
      const remaining = [...record.occurrences];
      for (const target of expected.occurrences) {
        const index = remaining.findIndex(value => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false;
          const occurrence = value as Record<string, unknown>;
          const source = occurrence.source && typeof occurrence.source === "object"
            ? occurrence.source as Record<string, unknown>
            : undefined;
          return (
            (target.source_id === undefined || source?.id === target.source_id) &&
            (target.discovery_turn === undefined ||
              occurrence.discovery_turn === target.discovery_turn) &&
            (target.extension_point_contains === undefined ||
              (typeof occurrence.extension_point === "string" &&
                occurrence.extension_point.includes(target.extension_point_contains))) &&
            (target.tool_call_id === undefined ||
              occurrence.tool_call_id === target.tool_call_id) &&
            (target.related_turns === undefined ||
              isDeepStrictEqual(occurrence.related_turns, target.related_turns))
          );
        });
        if (index < 0) {
          errors.push(`Missing grounded occurrence: ${JSON.stringify(target)}`);
        } else {
          remaining.splice(index, 1);
        }
      }
    }
  }
  return errors;
}

/** Verifies result selection/cardinality and reviewed semantics for one case. */
export function checkCaseV2(
  row: EvaluationCaseV2,
  evaluations: readonly Evaluation[],
  gold: GoldV2,
  selection: readonly string[] = row.elements,
): string[] {
  const errors: string[] = [];
  for (const id of selection) {
    const count = evaluations.filter(evaluation => evaluation.element.id === id).length;
    if (count !== 1) {
      errors.push(`Expected exactly one result for ${id}, got ${count}`);
    }
  }
  for (const evaluation of evaluations) {
    if (!selection.includes(evaluation.element.id)) {
      errors.push(`Unexpected result for ${evaluation.element.id}`);
      continue;
    }
    const expected = gold[row.id]?.[evaluation.element.id];
    if (!expected) {
      throw new Error(`Missing gold for ${row.id}/${evaluation.element.id}`);
    }
    errors.push(
      ...assertObservationV2(evaluation.result, expected)
        .map(error => `${evaluation.element.id}: ${error}`),
    );
  }
  return errors;
}
