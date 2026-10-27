// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  DeterministicHandlerInput,
  HandlerProvider,
} from "./handlers.js";
import {
  freezeTaxonomyInput,
  type TaxonomyInput,
} from "./scope-atif.js";
import type {
  NormalizedElement,
  NormalizedTaxonomy,
} from "./taxonomy.js";

export const EVALUATION_SCHEMA_VERSION = "scope/taxonomy-evaluation/v1";

/** Serializable taxonomy identity embedded in every new evaluation envelope. */
export interface EvaluationTaxonomyIdentity {
  /** Authored taxonomy ID. */
  id: string;
  /** Authored semantic version. */
  version: string;
  /** Canonical semantic digest. */
  digest: string;
}

/** Serializable element metadata embedded for readout/replay without reloading YAML. */
export interface EvaluationElementIdentity {
  /** Stable element ID. */
  id: string;
  /** Reviewer-facing label. */
  label: string;
  /** Optional static category derived by reports. */
  category_id?: string;
}

/** Execution provenance kept separate from semantic result fields. */
export interface EvaluationImplementation {
  /** Prompt or deterministic execution strategy. */
  type: "prompt" | "deterministic";
  /** Deterministic handler ID, when applicable. */
  handler?: string;
  /** Provider provenance, when applicable. */
  provider?: HandlerProvider;
}

/** New YAML-taxonomy evaluation envelope. */
export interface Evaluation {
  /** Version of this result envelope. */
  schema_version: typeof EVALUATION_SCHEMA_VERSION;
  /** Taxonomy identity/digest used for interpretation. */
  taxonomy: EvaluationTaxonomyIdentity;
  /** Element identity/metadata used by readouts. */
  element: EvaluationElementIdentity;
  /** Strategy and deterministic provider provenance. */
  implementation: EvaluationImplementation;
  /** Output validated against the element's authored YAML schema. */
  result: unknown;
}

/** Prompt executor receives the loaded production element definition. */
export interface PromptExecutor {
  /**
   * @param element - Loaded prompt element containing authored instructions/schema.
   * @param input - Frozen normalized ATIF plus taxonomy.
   * @returns Untrusted model output validated by the engine.
   */
  evaluate(element: NormalizedElement, input: TaxonomyInput): Promise<unknown>;
}

/** Returns trusted task text from the Scope extension or recorded user turns. */
function hasTaskEvidence(input: TaxonomyInput): boolean {
  return Boolean(
    input.atif.extra?.scope?.task ||
    input.atif.steps.some(step => step.source === "user" && step.message.trim()),
  );
}

/** Finds a globally normalized ATIF step by ID. */
function findStep(input: TaxonomyInput, stepId: number) {
  return input.atif.steps.find(step => step.step_id === stepId);
}

/** Validates dynamic source/turn/call grounding after authored schema validation. */
function validateEvidenceGrounding(
  element: NormalizedElement,
  result: unknown,
  input: TaxonomyInput,
): string[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const record = result as Record<string, unknown>;
  if (record.state !== "completed" || record.observed !== true) return [];
  if (!Array.isArray(record.occurrences)) return [];

  const sources = new Map(
    (input.atif.extra?.scope?.available_sources ?? []).map(source => [source.id, source]),
  );
  const errors: string[] = [];

  record.occurrences.forEach((rawOccurrence, index) => {
    if (!rawOccurrence || typeof rawOccurrence !== "object" || Array.isArray(rawOccurrence)) return;
    const occurrence = rawOccurrence as Record<string, unknown>;
    const source = occurrence.source && typeof occurrence.source === "object"
      ? occurrence.source as Record<string, unknown>
      : undefined;
    if (source) {
      const declared = typeof source.id === "string" ? sources.get(source.id) : undefined;
      if (!declared || JSON.stringify(declared) !== JSON.stringify(source)) {
        errors.push(`$.occurrences[${index}].source is not a supplied Scope source`);
      }
    }

    if (element.evidence.requires_discovery_event) {
      const discoveryTurn = occurrence.discovery_turn;
      const extensionPoint = occurrence.extension_point;
      if (
        !source ||
        typeof source.id !== "string" ||
        typeof discoveryTurn !== "number" ||
        typeof extensionPoint !== "string"
      ) {
        errors.push(`$.occurrences[${index}] must contain source, discovery_turn, and extension_point`);
      } else {
        const step = findStep(input, discoveryTurn);
        const grounded = step?.extra?.scope?.discoveries?.some(discovery =>
          discovery.source_id === source.id &&
          discovery.extension_point === extensionPoint
        );
        if (!grounded) {
          errors.push(`$.occurrences[${index}] is not grounded in a Scope discovery event`);
        }
      }
    }

    const relatedTurns = Array.isArray(occurrence.related_turns)
      ? occurrence.related_turns.filter((value): value is number =>
        typeof value === "number"
      )
      : [];
    for (const turn of relatedTurns) {
      if (!findStep(input, turn)) {
        errors.push(`$.occurrences[${index}].related_turns contains unknown step ${turn}`);
      }
    }

    if (typeof occurrence.tool_call_id === "string") {
      const step = input.atif.steps.find(candidate =>
        relatedTurns.includes(candidate.step_id) &&
        candidate.tool_calls?.some(call => call.tool_call_id === occurrence.tool_call_id),
      );
      if (!step) {
        errors.push(`$.occurrences[${index}].tool_call_id is not grounded in related_turns`);
      } else if (
        source?.id &&
        step.tool_calls?.find(call => call.tool_call_id === occurrence.tool_call_id)
          ?.extra?.scope?.source_id !== source.id
      ) {
        errors.push(`$.occurrences[${index}] call/source attribution does not match`);
      }
    }
  });
  return errors;
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

/** Builds one result envelope after schema and evidence validation. */
function evaluationEnvelope(
  taxonomy: NormalizedTaxonomy,
  element: NormalizedElement,
  result: unknown,
): Evaluation {
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
    implementation: element.implementation.type === "prompt"
      ? { type: "prompt" }
      : {
        type: "deterministic",
        handler: element.implementation.handler,
        ...(element.handlerProvider ? { provider: element.handlerProvider } : {}),
      },
    result,
  };
}

/**
 * Evaluates one loaded element against normalized evidence.
 *
 * Invalid input/taxonomy selection throws. Implementation/output failures
 * become authored-schema-compatible `state:error` results when that shape is
 * accepted, otherwise they throw rather than bypassing the YAML contract.
 */
export async function evaluateElement(
  input: TaxonomyInput,
  elementId: string,
  executor?: PromptExecutor,
): Promise<Evaluation> {
  const runtimeInput: TaxonomyInput = {
    atif: freezeTaxonomyInput(structuredClone(input.atif)),
    taxonomy: input.taxonomy,
  };
  const element = input.taxonomy.elementById.get(elementId);
  if (!element) {
    throw new Error(`Taxonomy '${input.taxonomy.id}' has no element '${elementId}'`);
  }

  const trajectoryState = input.atif.extra?.scope?.trajectory_state ?? "complete";
  if (element.evidence.complete_for_negative && trajectoryState !== "complete") {
    const result = {
      state: "indeterminate",
      reason: `${element.label} requires complete trajectory evidence for absence conclusions.`,
    };
    const errors = element.validateOutput(result);
    if (errors.length) throw new Error(errors.join("; "));
    return evaluationEnvelope(input.taxonomy, element, result);
  }
  if (element.evidence.requires_task && !hasTaskEvidence(input)) {
    const result = {
      state: "indeterminate",
      reason: `${element.label} requires task evidence to assess relevance.`,
    };
    const errors = element.validateOutput(result);
    if (errors.length) throw new Error(errors.join("; "));
    return evaluationEnvelope(input.taxonomy, element, result);
  }

  let result: unknown;
  try {
    if (element.implementation.type === "deterministic") {
      if (!element.resolvedHandler) {
        throw new Error(`Element '${element.id}' has no resolved deterministic handler`);
      }
      result = await element.resolvedHandler.evaluate(
        deterministicHandlerInput(runtimeInput),
        freezeTaxonomyInput(structuredClone(element.implementation.config)),
      );
    } else {
      if (!executor) {
        throw new Error("Prompt execution requires an explicit prompt executor");
      }
      result = await executor.evaluate(element, runtimeInput);
    }
  } catch (error) {
    result = {
      state: "error",
      error: error instanceof AggregateError
        ? `${error.message}: ${error.errors.map(cause =>
          cause instanceof Error ? cause.message : String(cause)
        ).join("; ")}`
        : error instanceof Error ? error.message : String(error),
    };
  }

  const errors = [
    ...element.validateOutput(result),
    ...validateEvidenceGrounding(element, result, input),
  ];
  if (errors.length) {
    throw new Error(`Element '${element.id}' returned invalid output: ${errors.join("; ")}`);
  }
  return evaluationEnvelope(input.taxonomy, element, result);
}

/** Evaluates unique element IDs in caller order without cross-element batching. */
export async function evaluate(
  input: TaxonomyInput,
  elementIds: readonly string[],
  executor?: PromptExecutor,
): Promise<Evaluation[]> {
  if (!elementIds.length || new Set(elementIds).size !== elementIds.length) {
    throw new Error("Choose a nonempty, unique element selection");
  }

  const evaluations: Evaluation[] = [];
  for (const elementId of elementIds) {
    evaluations.push(await evaluateElement(input, elementId, executor));
  }
  return evaluations;
}
