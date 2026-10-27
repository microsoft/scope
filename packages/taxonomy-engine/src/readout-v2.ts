// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  EVALUATION_SCHEMA_VERSION,
  type Evaluation,
} from "./engine.js";
import type { NormalizedTaxonomy } from "./taxonomy.js";

const readoutRunSchema = z.object({
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
  results: z.array(z.object({
    schema_version: z.literal(EVALUATION_SCHEMA_VERSION),
    taxonomy: z.object({
      id: z.string(),
      version: z.string(),
      digest: z.string(),
    }).passthrough(),
    element: z.object({
      id: z.string(),
      label: z.string(),
      category_id: z.string().optional(),
    }).strict(),
    implementation: z.object({
      type: z.enum(["prompt", "deterministic"]),
    }).passthrough(),
    result: z.unknown(),
  }).strict()),
}).strict();

export type ReadoutRunV2 = z.infer<typeof readoutRunSchema>;

/** Builds dynamic behavior/source frequencies from v2 evaluation envelopes. */
export function buildReadoutV2(
  value: unknown,
  taxonomy?: NormalizedTaxonomy,
) {
  const runs = z.array(readoutRunSchema).parse(value);
  const runIds = new Set<string>();
  const taxonomyDigests = new Set<string>();
  const groups = new Map<string, ReadoutRunV2[]>();

  for (const run of runs) {
    if (runIds.has(run.run.id)) {
      throw new Error(`Duplicate readout run '${run.run.id}'`);
    }
    runIds.add(run.run.id);
    if (new Set(run.results.map(result => result.element.id)).size !== run.results.length) {
      throw new Error(`Run '${run.run.id}' contains duplicate element results`);
    }
    for (const result of run.results) {
      taxonomyDigests.add(result.taxonomy.digest);
      if (taxonomy && result.taxonomy.digest !== taxonomy.digest) {
        throw new Error(
          `Readout result taxonomy digest '${result.taxonomy.digest}' does not match '${taxonomy.digest}'`,
        );
      }
    }
    const key = JSON.stringify([run.run.scenario.id, run.run.profile.id]);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  if (taxonomyDigests.size > 1) {
    throw new Error("Readout cannot combine results from different taxonomy digests");
  }

  return {
    schema_version: "scope/taxonomy-readout/v1",
    taxonomy_digest: [...taxonomyDigests][0] ?? taxonomy?.digest,
    groups: [...groups.values()].map(group => {
      const elementMetadata = new Map<string, Evaluation["element"]>();
      for (const run of group) {
        for (const result of run.results) {
          const existing = elementMetadata.get(result.element.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(result.element)) {
            throw new Error(`Element '${result.element.id}' metadata is inconsistent`);
          }
          elementMetadata.set(result.element.id, result.element);
        }
      }

      return {
        scenario: group[0].run.scenario,
        profile: group[0].run.profile,
        behaviors: [...elementMetadata.values()].map(element => {
          const coverage = {
            total: group.length,
            assessed: 0,
            unknown: 0,
            inapplicable: 0,
            error: 0,
            missing: 0,
          };
          const sourceCounts = new Map<string, {
            source?: Record<string, unknown>;
            runs: Set<string>;
            occurrences: number;
            evidence: unknown[];
          }>();
          let distinctRuns = 0;
          let occurrenceCount = 0;

          for (const run of group) {
            const evaluation = run.results.find(result => result.element.id === element.id);
            if (!evaluation) {
              coverage.unknown++;
              coverage.missing++;
              continue;
            }
            const result = evaluation.result as Record<string, unknown>;
            if (result.state !== "completed") {
              if (result.state === "indeterminate") coverage.unknown++;
              else if (result.state === "inapplicable") coverage.inapplicable++;
              else coverage.error++;
              continue;
            }
            coverage.assessed++;
            if (result.observed !== true || !Array.isArray(result.occurrences)) continue;
            distinctRuns++;
            occurrenceCount += result.occurrences.length;

            for (const occurrenceValue of result.occurrences) {
              const occurrence = occurrenceValue as Record<string, unknown>;
              const source = occurrence.source &&
                typeof occurrence.source === "object" &&
                !Array.isArray(occurrence.source)
                ? occurrence.source as Record<string, unknown>
                : undefined;
              const key = source
                ? JSON.stringify([source.surface_id, source.id])
                : "unattributed";
              const count = sourceCounts.get(key) ?? {
                source,
                runs: new Set<string>(),
                occurrences: 0,
                evidence: [],
              };
              count.runs.add(run.run.id);
              count.occurrences++;
              count.evidence.push({ run_id: run.run.id, ...occurrence });
              sourceCounts.set(key, count);
            }
          }

          return {
            element_id: element.id,
            label: element.label,
            ...(element.category_id ? { category_id: element.category_id } : {}),
            coverage,
            distinct_runs: distinctRuns,
            occurrences: occurrenceCount,
            sources: [...sourceCounts.values()].map(count => ({
              ...(count.source ? { source: count.source } : {}),
              distinct_runs: count.runs.size,
              occurrences: count.occurrences,
              evidence: count.evidence,
            })),
          };
        }),
      };
    }),
  };
}

/** Renders v2 readout counts and evidence as Markdown without inference. */
export function readoutMarkdownV2(
  report: ReturnType<typeof buildReadoutV2>,
): string {
  const lines = ["# Taxonome behavior preview", ""];
  for (const group of report.groups) {
    lines.push(
      `## ${group.scenario.label} / ${group.profile.label}`,
      "",
      "| Behavior / source | Distinct runs / total | Occurrences | Assessed | Unknown | Inapplicable | Error |",
      "|---|---:|---:|---:|---:|---:|---:|",
    );
    for (const behavior of group.behaviors) {
      const coverage = behavior.coverage;
      lines.push(
        `| ${behavior.label} | ${behavior.distinct_runs}/${coverage.total} | ${behavior.occurrences} | ${coverage.assessed} | ${coverage.unknown} | ${coverage.inapplicable} | ${coverage.error} |`,
      );
      for (const source of behavior.sources) {
        const label = String(source.source?.label ?? "(unattributed)")
          .replaceAll("|", "\\|")
          .replaceAll("\n", " ");
        lines.push(
          `| ${behavior.label} / ${label} | ${source.distinct_runs}/${coverage.total} | ${source.occurrences} | ${coverage.assessed} | ${coverage.unknown} | ${coverage.inapplicable} | ${coverage.error} |`,
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
        JSON.stringify(behavior.sources.flatMap(source => source.evidence), null, 2),
        "```",
        "",
      );
    }
  }
  return lines.join("\n");
}
