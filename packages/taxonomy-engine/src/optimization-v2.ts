// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import {
  axDeserializeOptimizedProgram,
  axSerializeOptimizedProgram,
  optimize,
  type AxAIService,
  type AxSerializedOptimizedProgram,
} from "@ax-llm/ax";
import { z } from "zod";
import {
  assertObservationV2,
  type EvaluationCaseV2,
  type GoldV2,
} from "./cases-v2.js";
import { validateScopeAtif, type TaxonomyInput } from "./scope-atif.js";
import {
  createTaxonomyPromptProgram,
  taxonomyPromptEvidence,
  YAML_OBSERVATION_CONTRACT,
} from "./prompt.js";
import type {
  NormalizedElement,
  NormalizedTaxonomy,
} from "./taxonomy.js";

export const OPTIMIZATION_ARTIFACT_VERSION = "scope/taxonome-ax/v2";

/** Hashes semantic JSON values used in artifact compatibility checks. */
export const semanticHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const serializedProgramSchema = z.custom<AxSerializedOptimizedProgram>(value =>
  z.object({
    bestScore: z.number(),
    stats: z.object({}).passthrough(),
    optimizerType: z.string(),
    optimizationTime: z.number(),
    totalRounds: z.number(),
    converged: z.boolean(),
  }).passthrough().safeParse(value).success
);

export const optimizationArtifactSchemaV2 = z.object({
  format: z.literal(OPTIMIZATION_ARTIFACT_VERSION),
  taxonomy: z.object({
    schema_version: z.literal("scope/taxonomy/v1"),
    id: z.string(),
    version: z.string(),
    digest: z.string(),
  }).strict(),
  element_id: z.string(),
  contract_hash: z.string(),
  corpus_hash: z.string(),
  model: z.string(),
  ax_version: z.literal("25.3.2"),
  sdk_version: z.literal("1.0.1"),
  train_ids: z.array(z.string()),
  validation_ids: z.array(z.string()),
  settings: z.object({
    maxMetricCalls: z.number().int().positive(),
    seed: z.number().int(),
    bootstrap: z.literal(true),
  }).strict(),
  transport_settings: z.object({
    reasoning_effort: z.literal("low"),
    sampling: z.literal("sdk-managed"),
    ax_sampling_hints_applied: z.literal(false),
  }).strict(),
  optimized: serializedProgramSchema,
  metric_trace: z.array(z.object({
    case_id: z.string(),
    score: z.number(),
    errors: z.array(z.string()),
    prediction: z.unknown(),
  }).strict()),
}).strict();

export type OptimizationArtifactV2 = z.infer<typeof optimizationArtifactSchemaV2>;

/** Computes compatibility hash over the loaded element and immutable trust wrapper. */
export function promptContractHash(
  taxonomy: NormalizedTaxonomy,
  element: NormalizedElement,
): string {
  return semanticHash({
    taxonomy_digest: taxonomy.digest,
    element: {
      id: element.id,
      implementation: element.implementation,
      evidence: element.evidence,
      output_schema: element.output_schema,
    },
    wrapper: YAML_OBSERVATION_CONTRACT,
  });
}

/**
 * Restores a v2 artifact only for its exact taxonomy/element/model contract.
 * Historical `taxonome.ax.v1` artifacts fail clearly rather than being
 * silently reinterpreted under YAML semantics.
 */
export function restoreOptimizationArtifactV2(
  value: unknown,
  taxonomy: NormalizedTaxonomy,
  elementId: string,
  model: string,
): OptimizationArtifactV2 {
  if (
    value &&
    typeof value === "object" &&
    "format" in value &&
    (value as { format?: unknown }).format === "taxonome.ax.v1"
  ) {
    throw new Error(
      "Historical taxonome.ax.v1 artifacts are incompatible with scope/taxonomy/v1; rerun optimization explicitly.",
    );
  }
  const artifact = optimizationArtifactSchemaV2.parse(value);
  const element = taxonomy.elementById.get(elementId);
  if (!element || element.implementation.type !== "prompt") {
    throw new Error(`Taxonomy prompt element '${elementId}' is required for artifact replay`);
  }
  if (
    artifact.taxonomy.digest !== taxonomy.digest ||
    artifact.element_id !== elementId ||
    artifact.model !== model ||
    artifact.contract_hash !== promptContractHash(taxonomy, element)
  ) {
    throw new Error("Optimization artifact taxonomy/element/model contract mismatch");
  }
  return artifact;
}

/** Converts fixed gold into one supervised training observation. */
function trainingObservation(
  row: EvaluationCaseV2,
  gold: GoldV2,
  elementId: string,
): object {
  const expected = gold[row.id]?.[elementId];
  if (!expected) throw new Error(`Missing gold for ${row.id}/${elementId}`);
  if (
    expected.exact !== undefined &&
    expected.exact &&
    typeof expected.exact === "object" &&
    !Array.isArray(expected.exact)
  ) {
    return expected.exact as object;
  }
  if (expected.state === "completed" && expected.observed === false) {
    return { state: "completed", observed: false };
  }
  if (expected.state === "completed" && expected.observed === true) {
    return {
      state: "completed",
      observed: true,
      occurrences: expected.occurrences?.map(occurrence => {
        const source = row.atif.extra?.scope?.available_sources
          .find(candidate => candidate.id === occurrence.source_id);
        return {
          ...(occurrence.extension_point_contains
            ? { extension_point: occurrence.extension_point_contains }
            : {}),
          ...(source ? { source } : {}),
          ...(occurrence.discovery_turn !== undefined
            ? { discovery_turn: occurrence.discovery_turn }
            : {}),
          ...(occurrence.related_turns
            ? { related_turns: occurrence.related_turns }
            : {}),
          ...(occurrence.tool_call_id
            ? { tool_call_id: occurrence.tool_call_id }
            : {}),
        };
      }),
    };
  }
  return {
    state: expected.state,
    ...(expected.state === "error"
      ? { error: "Reviewed expected execution error." }
      : { reason: "Reviewed expected unassessed state." }),
  };
}

/** Runs bounded bootstrap+GEPA for one loaded prompt element. */
export async function optimizePromptElementV2(
  taxonomy: NormalizedTaxonomy,
  elementId: string,
  cases: readonly EvaluationCaseV2[],
  gold: GoldV2,
  studentAI: AxAIService,
  teacherAI: AxAIService,
  model: string,
  maxMetricCalls = 48,
): Promise<OptimizationArtifactV2> {
  const element = taxonomy.elementById.get(elementId);
  if (!element || element.implementation.type !== "prompt") {
    throw new Error(`Cannot optimize non-prompt element '${elementId}'`);
  }
  const eligible = cases.filter(row =>
    row.elements.includes(elementId) &&
    row.atif.extra?.scope?.trajectory_state === "complete" &&
    (!element.evidence.requires_task ||
      row.atif.extra?.scope?.task ||
      row.atif.steps.some(step => step.source === "user" && step.message.trim()))
  );
  const train = eligible.filter(row => row.split === "train");
  const validation = eligible.filter(row => row.split === "validation");
  if (!train.length || !validation.length) {
    throw new Error("Optimization requires eligible disjoint train and validation cases");
  }
  for (const row of train) {
    if (validation.some(candidate =>
      candidate.family === row.family ||
      candidate.originating_run === row.originating_run
    )) {
      throw new Error("Train/validation family or originating-run leakage");
    }
  }

  const inputFor = (row: EvaluationCaseV2): TaxonomyInput => ({
    atif: row.atif,
    taxonomy,
  });
  const rowsByEvidence = new Map(
    [...train, ...validation].map(row => [
      taxonomyPromptEvidence(inputFor(row)),
      row,
    ]),
  );
  const trace: OptimizationArtifactV2["metric_trace"] = [];
  const program = createTaxonomyPromptProgram(element);
  const optimized = await optimize(
    program,
    train.map(row => ({
      evidence: taxonomyPromptEvidence(inputFor(row)),
      observation: trainingObservation(row, gold, elementId),
    })),
    ({ prediction, example }) => {
      const parsedExample = z.object({ evidence: z.string() }).passthrough().parse(example);
      const row = rowsByEvidence.get(parsedExample.evidence);
      if (!row) throw new Error("Optimizer attempted to score an unregistered case");
      validateScopeAtif(row.atif, taxonomy);
      const parsedPrediction = z.object({ observation: z.unknown() }).passthrough().parse(prediction);
      const schemaErrors = element.validateOutput(parsedPrediction.observation);
      const assertionErrors = schemaErrors.length
        ? schemaErrors
        : assertObservationV2(
          parsedPrediction.observation,
          gold[row.id][elementId]!,
        );
      const score = assertionErrors.length ? 0 : 1;
      trace.push({
        case_id: row.id,
        score,
        errors: assertionErrors,
        prediction,
      });
      return score;
    },
    {
      studentAI,
      teacherAI,
      validationExamples: validation.map(row => ({
        evidence: taxonomyPromptEvidence(inputFor(row)),
      })),
      maxMetricCalls,
      maxIterations: 2,
      earlyStoppingPatience: 2,
      skipPerfectScore: false,
      bootstrap: {
        maxRounds: 1,
        maxExamples: train.length,
        maxDemos: 2,
        batchSize: 1,
        dynamicTemperature: false,
        adaptiveBatching: false,
      },
      seed: 42,
      verbose: false,
      logger: () => {},
      optimizerLogger: () => {},
    },
  );
  if (!optimized.optimizedProgram) {
    throw new Error("Ax did not return a serializable optimized program");
  }

  return {
    format: OPTIMIZATION_ARTIFACT_VERSION,
    taxonomy: {
      schema_version: taxonomy.schema_version,
      id: taxonomy.id,
      version: taxonomy.version,
      digest: taxonomy.digest,
    },
    element_id: elementId,
    contract_hash: promptContractHash(taxonomy, element),
    corpus_hash: semanticHash({
      train: train.map(row => row.id),
      validation: validation.map(row => row.id),
      gold: Object.fromEntries(
        [...train, ...validation].map(row => [row.id, gold[row.id]]),
      ),
    }),
    model,
    ax_version: "25.3.2",
    sdk_version: "1.0.1",
    train_ids: train.map(row => row.id),
    validation_ids: validation.map(row => row.id),
    settings: { maxMetricCalls, seed: 42, bootstrap: true },
    transport_settings: {
      reasoning_effort: "low",
      sampling: "sdk-managed",
      ax_sampling_hints_applied: false,
    },
    optimized: axSerializeOptimizedProgram(optimized.optimizedProgram),
    metric_trace: trace,
  };
}

/** Converts the validated serialized program into Ax's runtime artifact object. */
export function deserializeOptimizationProgram(
  artifact: OptimizationArtifactV2,
) {
  return axDeserializeOptimizedProgram(artifact.optimized);
}
