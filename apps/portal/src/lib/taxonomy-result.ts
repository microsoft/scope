// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface TaxonomyEvidenceReference {
  role: string;
  path: string;
}

export type TaxonomyAssessment =
  | {
      state: "completed";
      observed: true;
      occurrences: Array<{ evidence: TaxonomyEvidenceReference[] }>;
    }
  | { state: "completed"; observed: false }
  | { state: "indeterminate"; reason: string }
  | { state: "inapplicable"; reason: string };

export interface TaxonomyEvaluation {
  status: "succeeded" | "failed";
  taxonomy: { id: string; version: string; digest: string };
  element: { id: string; label: string; category_id?: string };
  implementation: {
    type: "prompt" | "deterministic";
    handler?: string;
    provider?: { name: string; version?: string; origin: string };
    attempts: Array<{ attempt: 1 | 2; kind: string; outcome: string }>;
  };
  input: Record<string, unknown>;
  result?: TaxonomyAssessment;
  error?: {
    code: string;
    message: string;
    validation_errors?: Array<{
      code: string;
      output_path: string;
      role?: string;
      evidence_path?: string;
      message?: string;
    }>;
  };
}

export interface TaxonomyRunResult {
  run: {
    id: string;
    scenario: { id: string; label: string; task?: string };
    profile: { id: string; label: string };
  };
  results: TaxonomyEvaluation[];
  metadata?: unknown;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function string(value: Record<string, unknown>, key: string, name: string) {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`Invalid ${name}.${key}`);
  }
  return value[key] as string;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") throw new Error(`Invalid ${key}`);
  return candidate;
}

function parseAssessment(value: unknown): TaxonomyAssessment {
  const assessment = object(value, "Taxonome assessment");
  const state = string(assessment, "state", "Taxonome assessment");
  if (state === "indeterminate" || state === "inapplicable") {
    return {
      state,
      reason: string(assessment, "reason", "Taxonome assessment"),
    };
  }
  if (state !== "completed" || typeof assessment.observed !== "boolean") {
    throw new Error("Invalid Taxonome assessment state");
  }
  if (!assessment.observed) return { state, observed: false };
  if (!Array.isArray(assessment.occurrences)) {
    throw new Error("Invalid Taxonome assessment occurrences");
  }
  return {
    state,
    observed: true,
    occurrences: assessment.occurrences.map((candidate) => {
      const occurrence = object(candidate, "Taxonome occurrence");
      if (!Array.isArray(occurrence.evidence)) {
        throw new Error("Invalid Taxonome occurrence evidence");
      }
      return {
        evidence: occurrence.evidence.map((candidate) => {
          const evidence = object(candidate, "Taxonome evidence");
          return {
            role: string(evidence, "role", "Taxonome evidence"),
            path: string(evidence, "path", "Taxonome evidence"),
          };
        }),
      };
    }),
  };
}

/** Validates the browser boundary while retaining the typed result document. */
export function parseTaxonomyRunResult(value: unknown): TaxonomyRunResult {
  const root = object(value, "Taxonome result");
  const run = object(root.run, "Taxonome result.run");
  const scenario = object(run.scenario, "Taxonome result.run.scenario");
  const profile = object(run.profile, "Taxonome result.run.profile");
  if (!Array.isArray(root.results)) {
    throw new Error("Invalid Taxonome result.results");
  }
  const results = root.results.map((candidate, index) => {
    const evaluation = object(candidate, `Taxonome result.results[${index}]`);
    const statusValue = string(evaluation, "status", "Taxonome evaluation");
    if (statusValue !== "succeeded" && statusValue !== "failed") {
      throw new Error("Invalid Taxonome evaluation.status");
    }
    const status: TaxonomyEvaluation["status"] = statusValue;
    const taxonomy = object(evaluation.taxonomy, "Taxonome evaluation.taxonomy");
    const element = object(evaluation.element, "Taxonome evaluation.element");
    const implementation = object(
      evaluation.implementation,
      "Taxonome evaluation.implementation",
    );
    if (!Array.isArray(implementation.attempts)) {
      throw new Error("Invalid Taxonome evaluation attempts");
    }
    const implementationTypeValue = string(
      implementation,
      "type",
      "Taxonome implementation",
    );
    if (
      implementationTypeValue !== "prompt" &&
      implementationTypeValue !== "deterministic"
    ) {
      throw new Error("Invalid Taxonome implementation.type");
    }
    const implementationType: TaxonomyEvaluation["implementation"]["type"] =
      implementationTypeValue;
    const attempts = implementation.attempts.map((candidate) => {
      const attempt = object(candidate, "Taxonome attempt");
      const attemptNumber = attempt.attempt;
      if (attemptNumber !== 1 && attemptNumber !== 2) {
        throw new Error("Invalid Taxonome attempt.attempt");
      }
      return {
        attempt: attemptNumber,
        kind: string(attempt, "kind", "Taxonome attempt"),
        outcome: string(attempt, "outcome", "Taxonome attempt"),
      } satisfies TaxonomyEvaluation["implementation"]["attempts"][number];
    });
    const providerValue = implementation.provider;
    const provider =
      providerValue === undefined
        ? undefined
        : (() => {
            const candidate = object(providerValue, "Taxonome provider");
            return {
              name: string(candidate, "name", "Taxonome provider"),
              version: optionalString(candidate, "version"),
              origin: string(candidate, "origin", "Taxonome provider"),
            };
          })();
    const input = object(evaluation.input, "Taxonome evaluation.input");
    const result =
      status === "succeeded"
        ? parseAssessment(evaluation.result)
        : undefined;
    const errorValue =
      status === "failed"
        ? object(evaluation.error, "Taxonome evaluation.error")
        : undefined;
    const validationErrors =
      errorValue?.validation_errors === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(errorValue.validation_errors)) {
              throw new Error("Invalid Taxonome validation errors");
            }
            return errorValue.validation_errors.map((candidate) => {
              const diagnostic = object(candidate, "Taxonome diagnostic");
              return {
                code: string(diagnostic, "code", "Taxonome diagnostic"),
                output_path: string(
                  diagnostic,
                  "output_path",
                  "Taxonome diagnostic",
                ),
                role: optionalString(diagnostic, "role"),
                evidence_path: optionalString(diagnostic, "evidence_path"),
                message: optionalString(diagnostic, "message"),
              };
            });
          })();
    return {
      status,
      taxonomy: {
        id: string(taxonomy, "id", "Taxonome taxonomy"),
        version: string(taxonomy, "version", "Taxonome taxonomy"),
        digest: string(taxonomy, "digest", "Taxonome taxonomy"),
      },
      element: {
        id: string(element, "id", "Taxonome element"),
        label: string(element, "label", "Taxonome element"),
        ...(typeof element.category_id === "string"
          ? { category_id: element.category_id }
          : {}),
      },
      implementation: {
        type: implementationType,
        handler: optionalString(implementation, "handler"),
        provider,
        attempts,
      },
      input,
      ...(result ? { result } : {}),
      ...(errorValue
        ? {
            error: {
              code: string(errorValue, "code", "Taxonome evaluation error"),
              message: string(
                errorValue,
                "message",
                "Taxonome evaluation error",
              ),
              ...(validationErrors
                ? { validation_errors: validationErrors }
                : {}),
            },
          }
        : {}),
    };
  });
  return {
    run: {
      id: string(run, "id", "Taxonome run"),
      scenario: {
        id: string(scenario, "id", "Taxonome scenario"),
        label: string(scenario, "label", "Taxonome scenario"),
        ...(typeof scenario.task === "string" ? { task: scenario.task } : {}),
      },
      profile: {
        id: string(profile, "id", "Taxonome profile"),
        label: string(profile, "label", "Taxonome profile"),
      },
    },
    results,
    ...(root.metadata !== undefined ? { metadata: root.metadata } : {}),
  };
}
