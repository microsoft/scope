// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  Assessment,
  AttemptProvenance,
  EvaluationError,
  InputIdentity,
  ValidationDiagnostic,
} from "./assessment.js";
import {
  assessmentSchema,
  attemptProvenanceSchema,
  evaluationErrorSchema,
  inputIdentitySchema,
} from "./assessment.js";
import {
  validateAssessment,
  validateParsedAssessment,
} from "./evidence.js";
import { boundedErrorMessage } from "./errors.js";
import type {
  DeterministicHandlerInput,
  HandlerProvider,
} from "./handlers.js";
import {
  createInputIdentity,
  type InputIdentityContext,
} from "./input-identity.js";
import {
  freezeTaxonomyInput,
  type TaxonomyInput,
} from "./scope-atif.js";
import { evaluatePreconditions } from "./preconditions/index.js";
import type {
  NormalizedElement,
  NormalizedTaxonomy,
} from "./taxonomy.js";
import { z } from "zod";
import { originalAtifPath } from "./atif/index.js";

export const EVALUATION_SCHEMA_VERSION = "scope/taxonomy-evaluation/v1";

/** Serializable taxonomy identity embedded in every evaluation envelope. */
export interface EvaluationTaxonomyIdentity {
  id: string;
  version: string;
  digest: string;
}

/** Serializable element metadata embedded in every evaluation envelope. */
export interface EvaluationElementIdentity {
  id: string;
  label: string;
  category_id?: string;
}

/** Execution provenance kept separate from semantic assessment fields. */
export interface EvaluationImplementation {
  type: "prompt" | "deterministic";
  handler?: string;
  provider?: HandlerProvider;
  attempts: AttemptProvenance[];
}

interface EvaluationBase {
  schema_version: typeof EVALUATION_SCHEMA_VERSION;
  taxonomy: EvaluationTaxonomyIdentity;
  element: EvaluationElementIdentity;
  implementation: EvaluationImplementation;
  input: InputIdentity;
}

/** Successful execution containing one fully validated shared assessment. */
export interface SucceededEvaluation extends EvaluationBase {
  status: "succeeded";
  result: Assessment;
}

/** Failed execution containing only engine-owned error information. */
export interface FailedEvaluation extends EvaluationBase {
  status: "failed";
  error: EvaluationError;
}

export type Evaluation = SucceededEvaluation | FailedEvaluation;

const evaluationTaxonomySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const evaluationElementSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  category_id: z.string().min(1).optional(),
}).strict();

const evaluationImplementationSchema = z.object({
  type: z.enum(["prompt", "deterministic"]),
  handler: z.string().min(1).optional(),
  provider: z.object({
    name: z.string().min(1),
    version: z.string().min(1).optional(),
    origin: z.enum(["builtin", "local", "package"]),
    entry: z.string().min(1).optional(),
    integrity: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().optional(),
  attempts: z.array(attemptProvenanceSchema).min(1).max(2),
}).strict();

const evaluationBaseSchema = z.object({
  schema_version: z.literal(EVALUATION_SCHEMA_VERSION),
  taxonomy: evaluationTaxonomySchema,
  element: evaluationElementSchema,
  implementation: evaluationImplementationSchema,
  input: inputIdentitySchema,
});

/** Canonical persisted evaluation schema shared by resume and readout. */
export const evaluationSchema: z.ZodType<Evaluation> =
  z.discriminatedUnion("status", [
    evaluationBaseSchema.extend({
      status: z.literal("succeeded"),
      result: assessmentSchema,
    }).strict(),
    evaluationBaseSchema.extend({
      status: z.literal("failed"),
      error: evaluationErrorSchema,
    }).strict(),
  ]);

export type PromptExecutionResult =
  | {
    status: "succeeded";
    candidate: unknown;
    attempts: AttemptProvenance[];
  }
  | {
    status: "failed";
    attempts: AttemptProvenance[];
    error: EvaluationError;
  };

/** Prompt executor receives the loaded production element definition. */
export interface PromptExecutor {
  evaluate(
    element: NormalizedElement,
    input: TaxonomyInput,
    signal?: AbortSignal,
  ): Promise<PromptExecutionResult>;
}

/** Removes private mutable lookup maps before invoking third-party code. */
function deterministicHandlerInput(
  input: TaxonomyInput,
): DeterministicHandlerInput {
  const handlerInput: DeterministicHandlerInput = {
    atif: input.atif,
    taxonomy: {
      schema_version: input.taxonomy.schema_version,
      id: input.taxonomy.id,
      version: input.taxonomy.version,
      digest: input.taxonomy.digest,
      surfaces: structuredClone(input.taxonomy.surfaces),
    },
  };
  return freezeTaxonomyInput(handlerInput);
}

function implementation(
  element: NormalizedElement,
  attempts: AttemptProvenance[],
): EvaluationImplementation {
  return element.implementation.type === "prompt"
    ? { type: "prompt", attempts }
    : {
      type: "deterministic",
      handler: element.implementation.handler,
      ...(element.handlerProvider ? { provider: element.handlerProvider } : {}),
      attempts,
    };
}

function evaluationBase(
  taxonomy: NormalizedTaxonomy,
  element: NormalizedElement,
  input: InputIdentity,
  attempts: AttemptProvenance[],
): EvaluationBase {
  return {
    schema_version: EVALUATION_SCHEMA_VERSION,
    taxonomy: {
      id: taxonomy.id,
      version: taxonomy.version,
      digest: taxonomy.digest,
    },
    element: {
      id: element.id,
      label: element.label,
      ...(element.category_id ? { category_id: element.category_id } : {}),
    },
    implementation: implementation(element, attempts),
    input,
  };
}

function succeeded(
  taxonomy: NormalizedTaxonomy,
  element: NormalizedElement,
  input: InputIdentity,
  attempts: AttemptProvenance[],
  result: Assessment,
): SucceededEvaluation {
  return {
    ...evaluationBase(taxonomy, element, input, attempts),
    status: "succeeded",
    result,
  };
}

function failed(
  taxonomy: NormalizedTaxonomy,
  element: NormalizedElement,
  input: InputIdentity,
  attempts: AttemptProvenance[],
  error: EvaluationError,
): FailedEvaluation {
  return {
    ...evaluationBase(taxonomy, element, input, attempts),
    status: "failed",
    error,
  };
}

function validateCandidate(
  candidate: unknown,
  element: NormalizedElement,
  input: TaxonomyInput,
) {
  return validateAssessment(candidate, element.output, input.atif);
}

/** Maps normalized evidence diagnostics back to original input locations. */
function sourceLocations(
  input: TaxonomyInput,
  diagnostics: readonly ValidationDiagnostic[],
): EvaluationError["source_locations"] {
  if (!input.atif_provenance) return undefined;
  const locations = diagnostics.flatMap(diagnostic => {
    if (!diagnostic.evidence_path) return [];
    const original = originalAtifPath(
      input.atif_provenance!,
      diagnostic.evidence_path,
    );
    const source = original.source ?? input.atif_provenance!.source;
    return [{
      normalized_path: diagnostic.evidence_path,
      original_path: original.path,
      ...(source.file ? { file: source.file } : {}),
      ...(source.archive_entry
        ? { archive_entry: source.archive_entry }
        : {}),
      ...(source.jsonl_line
        ? { jsonl_line: source.jsonl_line }
        : {}),
      ...(original.generated_by
        ? { generated_by: original.generated_by }
        : {}),
    }];
  });
  return locations.length ? locations : undefined;
}

/** Returns one successful preflight or a validator failure envelope. */
function preflightEvaluation(
  input: TaxonomyInput,
  element: NormalizedElement,
  identity: InputIdentity,
  result: Assessment,
): Evaluation {
  const validation = validateCandidate(result, element, input);
  if (!validation.assessment) {
    return failed(input.taxonomy, element, identity, [{
      attempt: 1,
      kind: "initial",
      outcome: "invalid_output",
    }], {
      code: "invalid_output",
      message: "The engine-generated preflight assessment failed validation.",
      validation_errors: validation.diagnostics,
      source_locations: sourceLocations(input, validation.diagnostics),
    });
  }
  return succeeded(input.taxonomy, element, identity, [{
    attempt: 1,
    kind: "initial",
    outcome: "succeeded",
  }], validation.assessment);
}

/** Evaluates one loaded element against normalized evidence. */
export async function evaluateElement(
  input: TaxonomyInput,
  elementId: string,
  executor?: PromptExecutor,
  signal?: AbortSignal,
  identityContext: InputIdentityContext = {},
): Promise<Evaluation> {
  const runtimeInput: TaxonomyInput = {
    atif: freezeTaxonomyInput(structuredClone(input.atif)),
    taxonomy: input.taxonomy,
  };
  const element = input.taxonomy.elementById.get(elementId);
  if (!element) {
    throw new Error(
      `Taxonomy '${input.taxonomy.id}' has no element '${elementId}'`,
    );
  }
  const identity = createInputIdentity(input.atif, identityContext);
  if (signal?.aborted) {
    return failed(input.taxonomy, element, identity, [{
      attempt: 1,
      kind: "initial",
      outcome: "cancelled",
    }], {
      code: "cancelled",
      message: "Evaluation was cancelled before execution.",
    });
  }
  const preconditionResult = evaluatePreconditions(input.atif, element);
  if (preconditionResult) {
    return preflightEvaluation(input, element, identity, preconditionResult);
  }

  if (element.implementation.type === "deterministic") {
    const attempts: AttemptProvenance[] = [];
    let candidate: unknown;
    try {
      if (!element.resolvedHandler) {
        throw new Error(
          `Element '${element.id}' has no resolved deterministic handler`,
        );
      }
      candidate = await element.resolvedHandler.evaluate(
        deterministicHandlerInput(runtimeInput),
        freezeTaxonomyInput(
          structuredClone(element.implementation.config),
        ),
      );
    } catch (error) {
      attempts.push({
        attempt: 1,
        kind: "initial",
        outcome: signal?.aborted ? "cancelled" : "execution_failed",
      });
      return failed(input.taxonomy, element, identity, attempts, {
        code: signal?.aborted ? "cancelled" : "execution_failed",
        message: boundedErrorMessage(error),
      });
    }

    const validation = validateCandidate(candidate, element, input);
    if (!validation.assessment) {
      attempts.push({
        attempt: 1,
        kind: "initial",
        outcome: "invalid_output",
      });
      return failed(input.taxonomy, element, identity, attempts, {
        code: "invalid_output",
        message: "The deterministic assessment failed validation.",
        validation_errors: validation.diagnostics,
        source_locations: sourceLocations(input, validation.diagnostics),
      });
    }
    attempts.push({
      attempt: 1,
      kind: "initial",
      outcome: "succeeded",
    });
    return succeeded(
      input.taxonomy,
      element,
      identity,
      attempts,
      validation.assessment,
    );
  }

  if (!executor) {
    return failed(input.taxonomy, element, identity, [{
      attempt: 1,
      kind: "initial",
      outcome: "execution_failed",
    }], {
      code: "execution_failed",
      message: "Prompt execution requires an explicit prompt executor.",
    });
  }

  let execution: PromptExecutionResult;
  try {
    execution = await executor.evaluate(element, runtimeInput, signal);
  } catch (error) {
    const attempts: AttemptProvenance[] = [{
      attempt: 1,
      kind: "initial",
      outcome: signal?.aborted ? "cancelled" : "execution_failed",
    }];
    return failed(input.taxonomy, element, identity, attempts, {
      code: signal?.aborted ? "cancelled" : "execution_failed",
      message: boundedErrorMessage(error),
    });
  }
  if (execution.status === "failed") {
    const error = execution.error.validation_errors
      ? {
        ...execution.error,
        source_locations: sourceLocations(
          input,
          execution.error.validation_errors,
        ),
      }
      : execution.error;
    return failed(
      input.taxonomy,
      element,
      identity,
      execution.attempts,
      error,
    );
  }
  const validation = validateParsedAssessment(
    execution.candidate,
    element.output,
    input.atif,
  );
  if (!validation.assessment) {
    const attempts = execution.attempts.map((attempt, index, all) =>
      index === all.length - 1
        ? { ...attempt, outcome: "invalid_output" as const }
        : attempt
    );
    return failed(input.taxonomy, element, identity, attempts, {
      code: "invalid_output",
      message:
        "The Ax-accepted assessment failed the engine's final validation.",
      validation_errors: validation.diagnostics,
      source_locations: sourceLocations(
        input,
        validation.diagnostics,
      ),
    });
  }
  return succeeded(
    input.taxonomy,
    element,
    identity,
    execution.attempts,
    validation.assessment,
  );
}

/** Evaluates unique element IDs in caller order without cross-element batching. */
export async function evaluate(
  input: TaxonomyInput,
  elementIds: readonly string[],
  executor?: PromptExecutor,
  signal?: AbortSignal,
  identityContext: InputIdentityContext = {},
): Promise<Evaluation[]> {
  if (!elementIds.length || new Set(elementIds).size !== elementIds.length) {
    throw new Error("Choose a nonempty, unique element selection");
  }

  const evaluations: Evaluation[] = [];
  for (const elementId of elementIds) {
    evaluations.push(
      await evaluateElement(
        input,
        elementId,
        executor,
        signal,
        identityContext,
      ),
    );
  }
  return evaluations;
}
