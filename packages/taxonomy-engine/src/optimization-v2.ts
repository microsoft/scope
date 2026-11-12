// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  axDeserializeOptimizedProgram,
  axSerializeOptimizedProgram,
  optimize,
  type AxAIService,
  type AxSerializedOptimizedProgram,
} from "@ax-llm/ax";
import { z } from "zod";
import {
  ASSESSMENT_JSON_SCHEMA,
  NORMALIZED_ATIF_VERSION,
  PRODUCTION_REPAIR_POLICY,
  validationDiagnosticSchema,
  type ValidationDiagnostic,
} from "./assessment.js";
import { ATIF_INGESTION_POLICY_HASH } from "./atif/index.js";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { validateParsedAssessment } from "./evidence.js";
import {
  assertObservation,
  type EvaluationInput,
  type GroundTruth,
  type GroundTruthExpectation,
} from "./evaluation-inputs.js";
import {
  atifContentText,
  validateScopeAtif,
  type TaxonomyInput,
} from "./scope-atif.js";
import {
  createTaxonomyPromptProgram,
  TAXONOMY_AX_OUTPUT_CONTRACT,
  taxonomyPromptEvidence,
  YAML_OBSERVATION_CONTRACT,
} from "./prompt.js";
import type {
  NormalizedElement,
  NormalizedTaxonomy,
} from "./taxonomy.js";

export const OPTIMIZATION_ARTIFACT_VERSION = "scope/taxonome-ax/v2";

/** Hashes semantic JSON values used in artifact compatibility checks. */
export const semanticHash = canonicalJsonSha256;

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
    input_id: z.string(),
    score: z.number(),
    errors: z.array(z.string()),
    diagnostics: z.array(validationDiagnosticSchema),
    dimensions: z.object({
      schema_valid: z.boolean(),
      roles_valid: z.boolean(),
      references_resolved: z.boolean(),
      types_valid: z.boolean(),
      constraints_valid: z.boolean(),
      semantic_match: z.boolean(),
    }).strict(),
  }).strict()),
}).strict();

export type OptimizationArtifactV2 = z.infer<typeof optimizationArtifactSchemaV2>;

/** Dimensioned raw-candidate fitness produced without repair or model calls. */
export interface OptimizationCandidateScore {
  score: 0 | 1;
  errors: string[];
  diagnostics: ValidationDiagnostic[];
  dimensions: {
    schema_valid: boolean;
    roles_valid: boolean;
    references_resolved: boolean;
    types_valid: boolean;
    constraints_valid: boolean;
    semantic_match: boolean;
  };
}

/** Scores one raw Ax candidate with the same pure production validator. */
export function scoreOptimizationCandidate(
  candidate: unknown,
  input: EvaluationInput,
  element: NormalizedElement,
  expected: GroundTruthExpectation,
): OptimizationCandidateScore {
  const validation = validateParsedAssessment(
    candidate,
    element.output,
    input.atif,
  );
  const codes = new Set(validation.diagnostics.map(item => item.code));
  const dimensions = {
    schema_valid: !codes.has("invalid_json") && !codes.has("schema_mismatch"),
    roles_valid: !codes.has("unknown_role") &&
      !codes.has("role_cardinality") &&
      !codes.has("duplicate_reference"),
    references_resolved: !codes.has("invalid_jsonpath") &&
      !codes.has("unresolved_reference"),
    types_valid: !codes.has("reference_type_mismatch"),
    constraints_valid: !codes.has("reference_constraint_mismatch"),
    semantic_match: false,
  };
  const validationErrors = validation.diagnostics.map(diagnostic =>
    `${diagnostic.code}: ${diagnostic.message ?? diagnostic.output_path}`
  );
  if (!validation.assessment) {
    return {
      score: 0,
      errors: validationErrors,
      diagnostics: validation.diagnostics,
      dimensions,
    };
  }
  const assertionErrors = assertObservation(validation.assessment, expected);
  dimensions.semantic_match = assertionErrors.length === 0;
  return {
    score: dimensions.semantic_match ? 1 : 0,
    errors: assertionErrors,
    diagnostics: [],
    dimensions,
  };
}

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
      preconditions: element.preconditions,
      output: element.output,
    },
    assessment_schema: ASSESSMENT_JSON_SCHEMA,
    normalization: NORMALIZED_ATIF_VERSION,
    atif_ingestion_policy_hash: ATIF_INGESTION_POLICY_HASH,
    repair_policy: PRODUCTION_REPAIR_POLICY,
    ax_output_contract: TAXONOMY_AX_OUTPUT_CONTRACT,
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
  const parsed = optimizationArtifactSchemaV2.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Optimization artifact structure is incompatible with the current " +
      "shared assessment/evidence contract; rerun optimization explicitly.",
    );
  }
  const artifact = parsed.data;
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

/** Converts fixed ground truth into one supervised training observation. */
function trainingObservation(
  input: EvaluationInput,
  groundTruth: GroundTruth,
  elementId: string,
): object {
  const expected = groundTruth[input.id]?.[elementId];
  if (!expected) {
    throw new Error(`Missing ground truth for ${input.id}/${elementId}`);
  }
  return expected;
}

/** Runs bounded bootstrap+GEPA for one loaded prompt element. */
export async function optimizePromptElementV2(
  taxonomy: NormalizedTaxonomy,
  elementId: string,
  inputs: readonly EvaluationInput[],
  groundTruth: GroundTruth,
  studentAI: AxAIService,
  teacherAI: AxAIService,
  model: string,
  maxMetricCalls = 48,
): Promise<OptimizationArtifactV2> {
  const element = taxonomy.elementById.get(elementId);
  if (!element || element.implementation.type !== "prompt") {
    throw new Error(`Cannot optimize non-prompt element '${elementId}'`);
  }
  const eligible = inputs.filter(input =>
    input.elements.includes(elementId) &&
    input.atif.extra?.scope?.trajectory_state === "complete" &&
    (!element.preconditions.requires_task ||
      input.atif.extra?.scope?.task ||
      input.atif.steps.some(step =>
        step.source === "user" && atifContentText(step.message).trim()
      ))
  );
  const train = eligible.filter(row => row.split === "train");
  const validation = eligible.filter(row => row.split === "validation");
  if (!train.length || !validation.length) {
    throw new Error(
      "Optimization requires eligible disjoint train and validation inputs",
    );
  }
  for (const row of train) {
    if (validation.some(candidate =>
      candidate.family === row.family ||
      candidate.originating_run === row.originating_run
    )) {
      throw new Error("Train/validation family or originating-run leakage");
    }
  }

  const inputFor = (input: EvaluationInput): TaxonomyInput => ({
    atif: input.atif,
    atif_provenance: input.atif_provenance,
    taxonomy,
  });
  const inputsByContext = new Map(
    [...train, ...validation].map(input => [
      taxonomyPromptEvidence(inputFor(input)),
      input,
    ]),
  );
  const trace: OptimizationArtifactV2["metric_trace"] = [];
  const program = createTaxonomyPromptProgram(
    element,
    undefined,
    {
      correctionRetries: 0,
      captureInvalidOutput: true,
    },
  );
  const optimized = await optimize(
    program,
    train.map(input => ({
      trajectory_context: taxonomyPromptEvidence(inputFor(input)),
      observation: trainingObservation(input, groundTruth, elementId),
    })),
    ({ prediction, example }) => {
      const parsedExample = z.object({
        trajectory_context: z.string(),
      }).passthrough().parse(example);
      const input = inputsByContext.get(parsedExample.trajectory_context);
      if (!input) {
        throw new Error("Optimizer attempted to score an unregistered input");
      }
      validateScopeAtif(
        input.atif,
        taxonomy,
        input.atif_provenance,
      );
      const parsedPrediction = z.object({ observation: z.unknown() }).passthrough().parse(prediction);
      const scored = scoreOptimizationCandidate(
        parsedPrediction.observation,
        input,
        element,
        groundTruth[input.id][elementId]!,
      );
      trace.push({
        input_id: input.id,
        score: scored.score,
        errors: scored.errors,
        diagnostics: scored.diagnostics,
        dimensions: scored.dimensions,
      });
      return scored.score;
    },
    {
      studentAI,
      teacherAI,
      validationExamples: validation.map(input => ({
        trajectory_context: taxonomyPromptEvidence(inputFor(input)),
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
      ground_truth: Object.fromEntries(
        [...train, ...validation].map(input => [
          input.id,
          groundTruth[input.id],
        ]),
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
