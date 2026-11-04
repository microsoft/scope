// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  optimize,
  type AxAIService,
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
import { redactErrorText } from "./errors.js";
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

export const OPTIMIZATION_MANIFEST_VERSION =
  "scope/taxonome-optimization-manifest/v1" as const;

/** Hashes semantic JSON values used in provenance and compatibility checks. */
export const semanticHash = canonicalJsonSha256;

export const optimizationManifestSchema = z.object({
  schema_version: z.literal(OPTIMIZATION_MANIFEST_VERSION),
  taxonomy: z.object({
    schema_version: z.literal("scope/taxonomy/v1"),
    id: z.string(),
    version: z.string(),
    digest: z.string(),
  }).strict(),
  element_id: z.string(),
  source_element_sha256: z.string(),
  optimized_element_sha256: z.string(),
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
    bootstrap: z.literal(false),
  }).strict(),
  transport_settings: z.object({
    reasoning_effort: z.literal("low"),
    sampling: z.literal("sdk-managed"),
    ax_sampling_hints_applied: z.literal(false),
  }).strict(),
  metrics: z.object({
    best_score: z.number(),
    metric_calls: z.number().int().nonnegative(),
    total_rounds: z.number().int().nonnegative(),
    converged: z.boolean(),
    stop_reason: z.string().optional(),
    pareto_front_size: z.number().int().nonnegative().optional(),
    optimization_time_ms: z.number().nonnegative(),
  }).strict(),
  metric_trace: z.array(z.object({
    input_id: z.string(),
    split: z.enum(["train", "validation", "test"]).optional(),
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

export type OptimizationManifest = z.infer<typeof optimizationManifestSchema>;

/** Complete standard Taxonome prompt element emitted by optimization. */
export interface OptimizedPromptElement {
  schema_version?: "scope/taxonomy/v1";
  id: string;
  label: string;
  description?: string;
  category_id?: string;
  implementation: { type: "prompt"; prompt: string };
  preconditions: NormalizedElement["preconditions"];
  output: NormalizedElement["output"];
}

export interface OptimizationProgress {
  phase:
    | "preflight"
    | "optimizing"
    | "candidate"
    | "complete";
  elementId: string;
  metricCalls: number;
  trial?: number;
  totalTrials?: number;
  candidateCount?: number;
  candidateChanged?: boolean;
  latestScore?: number;
  bestScore?: number;
  paretoFrontSize?: number;
  stopReason?: string;
  message: string;
}

export interface OptimizedElementResult {
  element: OptimizedPromptElement;
  manifest: OptimizationManifest;
}

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

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function optionalParetoFrontSize(value: JsonRecord): number | undefined {
  return nonnegativeInteger(
    value.paretoFrontSize ?? value.pareto_front_size,
  );
}

/**
 * Converts structured Ax optimizer logger events into bounded public progress.
 * Signals absent from the Ax event are omitted instead of inferred.
 */
export class AxOptimizationProgressReporter {
  private candidateCount: number | undefined;
  private stopReason: string | undefined;

  constructor(
    private readonly elementId: string,
    private readonly metricCalls: () => number,
    private readonly emit: (progress: OptimizationProgress) => void,
    private readonly componentKey?: string,
    private readonly sourceInstruction?: string,
  ) {}

  handle(data: unknown): void {
    const event = asRecord(data);
    const name = typeof event?.name === "string" ? event.name : undefined;
    const value = asRecord(event?.value);
    if (!name || !value) return;

    const common = {
      elementId: this.elementId,
      metricCalls: this.metricCalls(),
    };
    const paretoFrontSize = optionalParetoFrontSize(value);

    switch (name) {
      case "OptimizationStart": {
        const optimizerType = typeof value.optimizerType === "string"
          ? value.optimizerType
          : "Ax";
        this.emit({
          phase: "optimizing",
          ...common,
          ...(paretoFrontSize === undefined ? {} : { paretoFrontSize }),
          message: `${optimizerType} started`,
        });
        return;
      }
      case "ConfigurationProposal": {
        const count = nonnegativeInteger(value.count);
        if (count !== undefined) this.candidateCount = count;
        const type = typeof value.type === "string" ? value.type : "candidate";
        this.emit({
          phase: "optimizing",
          ...common,
          ...(this.candidateCount === undefined
            ? {}
            : { candidateCount: this.candidateCount }),
          ...(paretoFrontSize === undefined ? {} : { paretoFrontSize }),
          message: `${type} proposal`,
        });
        return;
      }
      case "RoundProgress": {
        const trial = nonnegativeInteger(value.round);
        const totalTrials = nonnegativeInteger(value.totalRounds);
        const latestScore = finiteNumber(value.currentScore);
        const bestScore = finiteNumber(value.bestScore);
        this.emit({
          phase: "candidate",
          ...common,
          ...(trial === undefined ? {} : { trial }),
          ...(totalTrials === undefined ? {} : { totalTrials }),
          ...(this.candidateCount === undefined
            ? {}
            : { candidateCount: this.candidateCount }),
          ...(latestScore === undefined ? {} : { latestScore }),
          ...(bestScore === undefined ? {} : { bestScore }),
          ...(paretoFrontSize === undefined ? {} : { paretoFrontSize }),
          message: trial === undefined || totalTrials === undefined
            ? "trial scored"
            : `trial ${trial}/${totalTrials}`,
        });
        return;
      }
      case "BestConfigFound": {
        const score = finiteNumber(value.score);
        this.emit({
          phase: "candidate",
          ...common,
          ...(this.candidateCount === undefined
            ? {}
            : { candidateCount: this.candidateCount }),
          ...(score === undefined ? {} : {
            latestScore: score,
            bestScore: score,
          }),
          ...(paretoFrontSize === undefined ? {} : { paretoFrontSize }),
          message: "best candidate updated",
        });
        return;
      }
      case "EarlyStopping": {
        const reason = typeof value.reason === "string"
          ? value.reason
          : "early stop";
        this.stopReason = reason;
        const trial = nonnegativeInteger(value.round);
        const latestScore = finiteNumber(value.finalScore);
        this.emit({
          phase: "optimizing",
          ...common,
          ...(trial === undefined ? {} : { trial }),
          ...(latestScore === undefined ? {} : { latestScore }),
          ...(paretoFrontSize === undefined ? {} : { paretoFrontSize }),
          stopReason: reason,
          message: reason,
        });
        return;
      }
      case "OptimizationComplete": {
        const bestScore = finiteNumber(value.bestScore);
        const stats = asRecord(value.stats);
        const earlyStopping = asRecord(stats?.earlyStopping);
        const stopReason = this.stopReason ??
          (typeof earlyStopping?.reason === "string"
            ? earlyStopping.reason
            : undefined);
        this.emit({
          phase: "optimizing",
          ...common,
          ...(this.candidateCount === undefined
            ? {}
            : { candidateCount: this.candidateCount }),
          ...(bestScore === undefined ? {} : { bestScore }),
          ...(paretoFrontSize === undefined ? {} : { paretoFrontSize }),
          ...(stopReason === undefined ? {} : { stopReason }),
          message: "optimizer complete",
        });
      }
    }
  }

  /** Surfaces bounded Ax optimizer notifications such as teacher-call failures. */
  handleLogger(data: unknown): void {
    const event = asRecord(data);
    if (
      event?.name !== "Notification" ||
      typeof event.value !== "string"
    ) {
      return;
    }
    this.emit({
      phase: "optimizing",
      elementId: this.elementId,
      metricCalls: this.metricCalls(),
      message: redactErrorText(event.value),
    });
  }

  /** Maps Ax's typed round callback into one public progress snapshot. */
  handleRoundProgress(data: unknown): void {
    const progress = asRecord(data);
    if (!progress) return;
    const trial = nonnegativeInteger(progress.round);
    const totalTrials = nonnegativeInteger(progress.totalRounds);
    const latestScore = finiteNumber(progress.currentScore);
    const bestScore = finiteNumber(progress.bestScore);
    const configuration = asRecord(progress.currentConfiguration);
    const candidate = this.componentKey && configuration
      ? configuration[this.componentKey]
      : undefined;
    const candidateChanged = typeof candidate === "string" &&
      this.sourceInstruction !== undefined
      ? candidate.trim() !== this.sourceInstruction.trim()
      : undefined;
    if (trial !== undefined) {
      this.candidateCount = Math.max(this.candidateCount ?? 0, trial);
    }
    this.emit({
      phase: "candidate",
      elementId: this.elementId,
      metricCalls: this.metricCalls(),
      ...(trial === undefined ? {} : { trial }),
      ...(totalTrials === undefined ? {} : { totalTrials }),
      ...(latestScore === undefined ? {} : { latestScore }),
      ...(bestScore === undefined ? {} : { bestScore }),
      ...(this.candidateCount === undefined
        ? {}
        : { candidateCount: this.candidateCount }),
      ...(candidateChanged === undefined ? {} : { candidateChanged }),
      message: trial === undefined || totalTrials === undefined
        ? "trial evaluated"
        : `trial ${trial}/${totalTrials}` +
          `${candidateChanged === undefined
            ? ""
            : candidateChanged ? "; candidate changed" : "; candidate unchanged"}`,
    });
  }

  /** Records one real Ax proposal attempt without exposing instruction text. */
  handleProposal(changed: boolean): void {
    this.candidateCount = (this.candidateCount ?? 0) + 1;
    this.emit({
      phase: "optimizing",
      elementId: this.elementId,
      metricCalls: this.metricCalls(),
      candidateCount: this.candidateCount,
      candidateChanged: changed,
      message: changed ? "candidate changed" : "candidate unchanged",
    });
  }
}

/** Converts measured candidate failures into bounded GEPA evaluator feedback. */
export function optimizationFeedbackForCandidate(
  scored: OptimizationCandidateScore,
): string[] | undefined {
  return scored.score === 1
    ? undefined
    : scored.errors.map(error => `Assessment mismatch: ${error}`);
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
      ...(element.description ? { description: element.description } : {}),
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

function portablePromptElement(
  element: NormalizedElement,
  prompt: string,
): OptimizedPromptElement {
  return {
    schema_version: "scope/taxonomy/v1",
    id: element.id,
    label: element.label,
    ...(element.description ? { description: element.description } : {}),
    ...(element.category_id ? { category_id: element.category_id } : {}),
    implementation: { type: "prompt", prompt },
    preconditions: structuredClone(element.preconditions),
    output: structuredClone(element.output),
  };
}

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

/** Optimizes one prompt instruction without embedding examples or ATIF in output. */
export async function optimizePromptElement(
  taxonomy: NormalizedTaxonomy,
  elementId: string,
  inputs: readonly EvaluationInput[],
  groundTruth: GroundTruth,
  studentAI: AxAIService,
  teacherAI: AxAIService,
  model: string,
  maxMetricCalls = 48,
  onProgress?: (progress: OptimizationProgress) => void,
): Promise<OptimizedElementResult> {
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
      `Element '${elementId}' requires eligible Train and Validation inputs`,
    );
  }
  for (const row of [...train, ...validation]) {
    if (!groundTruth[row.id]?.[elementId]) {
      throw new Error(`Missing ground truth for ${row.id}/${elementId}`);
    }
  }
  for (const row of train) {
    if (validation.some(candidate =>
      candidate.family === row.family ||
      candidate.originating_run === row.originating_run
    )) {
      throw new Error(
        `Element '${elementId}' has Train/Validation family or originating-run leakage`,
      );
    }
  }

  onProgress?.({
    phase: "preflight",
    elementId,
    metricCalls: 0,
    message: `${train.length} Train; ${validation.length} Validation`,
  });
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
  const trace: OptimizationManifest["metric_trace"] = [];
  let optimizerProgress: AxOptimizationProgressReporter | undefined;
  const program = createTaxonomyPromptProgram(element, {
    correctionRetries: 0,
    captureInvalidOutput: true,
    onOptimizationCandidate: candidate =>
      optimizerProgress?.handleProposal(candidate.changed),
  });
  const scorePrediction = (
    prediction: unknown,
    example: unknown,
  ): {
    input: EvaluationInput;
    scored: OptimizationCandidateScore;
  } => {
    const parsedExample = z.object({
      trajectory_context: z.string(),
    }).passthrough().parse(example);
    const input = inputsByContext.get(parsedExample.trajectory_context);
    if (!input) {
      throw new Error("Optimizer attempted to score an unregistered input");
    }
    validateScopeAtif(input.atif, taxonomy, input.atif_provenance);
    const parsedPrediction = z.object({
      observation: z.unknown(),
    }).passthrough().parse(prediction);
    return {
      input,
      scored: scoreOptimizationCandidate(
        parsedPrediction.observation,
        input,
        element,
        groundTruth[input.id]![elementId]!,
      ),
    };
  };
  const recordScore = (
    input: EvaluationInput,
    scored: OptimizationCandidateScore,
  ): number => {
    trace.push({
      input_id: input.id,
      split: input.split,
      score: scored.score,
      errors: scored.errors,
      diagnostics: scored.diagnostics,
      dimensions: scored.dimensions,
    });
    onProgress?.({
      phase: "candidate",
      elementId,
      metricCalls: trace.length,
      latestScore: scored.score,
      message: `scored ${input.id}`,
    });
    return scored.score;
  };
  optimizerProgress = new AxOptimizationProgressReporter(
    elementId,
    () => trace.length,
    progress => onProgress?.(progress),
    program.getOptimizableComponents()[0]?.key,
    element.implementation.prompt,
  );
  const optimized = await optimize(
    program,
    train.map(input => ({
      trajectory_context: taxonomyPromptEvidence(inputFor(input)),
      observation: trainingObservation(input, groundTruth, elementId),
    })),
    ({ prediction, example }) => {
      const { input, scored } = scorePrediction(prediction, example);
      return recordScore(input, scored);
    },
    {
      studentAI,
      teacherAI,
      validationExamples: validation.map(input => ({
        trajectory_context: taxonomyPromptEvidence(inputFor(input)),
      })),
      feedbackFn: ({
        prediction,
        example,
      }: {
        prediction: unknown;
        example: unknown;
      }) => {
        const { scored } = scorePrediction(prediction, example);
        return optimizationFeedbackForCandidate(scored);
      },
      maxMetricCalls,
      maxIterations: 2,
      earlyStoppingPatience: 2,
      minibatchSize: train.length,
      skipPerfectScore: false,
      bootstrap: false,
      seed: 42,
      verbose: false,
      logger: data => optimizerProgress.handleLogger(data),
      optimizerLogger: data => optimizerProgress.handle(data),
      onProgress: progress =>
        optimizerProgress.handleRoundProgress(progress),
    },
  );
  if (!optimized.optimizedProgram) {
    throw new Error("Ax did not return an optimized program");
  }
  const serialized = optimized.optimizedProgram as unknown as {
    demos?: unknown[];
    examples?: unknown[];
  };
  if ((serialized.demos?.length ?? 0) > 0) {
    throw new Error("Optimizer returned runtime demos while bootstrap is disabled");
  }
  optimized.optimizedProgram.applyTo(program);
  const optimizedElement = portablePromptElement(
    element,
    program.optimizedInstruction(),
  );
  const sourceElement = portablePromptElement(
    element,
    element.implementation.prompt,
  );
  const optimizedRecord = asRecord(optimized);
  const paretoFrontSize = optimizedRecord
    ? optionalParetoFrontSize(optimizedRecord)
    : undefined;
  const stopReason = optimized.optimizedProgram.stats.earlyStopping?.reason ??
    (optimized.optimizedProgram.converged ? "converged" : "completed");
  const manifest: OptimizationManifest = {
    schema_version: OPTIMIZATION_MANIFEST_VERSION,
    taxonomy: {
      schema_version: taxonomy.schema_version,
      id: taxonomy.id,
      version: taxonomy.version,
      digest: taxonomy.digest,
    },
    element_id: elementId,
    source_element_sha256: semanticHash(sourceElement),
    optimized_element_sha256: semanticHash(optimizedElement),
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
    settings: { maxMetricCalls, seed: 42, bootstrap: false },
    transport_settings: {
      reasoning_effort: "low",
      sampling: "sdk-managed",
      ax_sampling_hints_applied: false,
    },
    metrics: {
      best_score: optimized.optimizedProgram.bestScore,
      metric_calls: trace.length,
      total_rounds: optimized.optimizedProgram.totalRounds,
      converged: optimized.optimizedProgram.converged,
      stop_reason: stopReason,
      ...(paretoFrontSize === undefined ? {} : {
        pareto_front_size: paretoFrontSize,
      }),
      optimization_time_ms: optimized.optimizedProgram.optimizationTime,
    },
    metric_trace: trace,
  };
  onProgress?.({
    phase: "complete",
    elementId,
    metricCalls: trace.length,
    trial: manifest.metrics.total_rounds,
    totalTrials: manifest.metrics.total_rounds,
    bestScore: manifest.metrics.best_score,
    ...(manifest.metrics.pareto_front_size === undefined ? {} : {
      paretoFrontSize: manifest.metrics.pareto_front_size,
    }),
    ...(manifest.metrics.stop_reason === undefined ? {} : {
      stopReason: manifest.metrics.stop_reason,
    }),
    message: "optimized YAML ready",
  });
  return { element: optimizedElement, manifest };
}
