// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  assessmentSchema,
  MAX_ASSESSMENT_REFERENCES,
  type Assessment,
  type EvidenceContract,
  type EvidenceType,
  type ValidationDiagnostic,
} from "./assessment.js";
import {
  contentPartSchema,
  type ScopeAtif,
} from "./scope-atif.js";

const MAX_JSONPATH_BYTES = 2_048;
const MAX_JSONPATH_SELECTORS = 64;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const forbiddenProperties = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export type JsonPathSelector =
  | { kind: "property"; value: string }
  | { kind: "index"; value: number };

export interface ParsedJsonPath {
  canonical: string;
  selectors: readonly JsonPathSelector[];
}

export interface ResolvedEvidence {
  canonicalPath: string;
  selectors: readonly JsonPathSelector[];
  node: unknown;
  type?: EvidenceType;
  stepPath?: string;
  stepIndex?: number;
  callPath?: string;
}

export interface ValidatedAssessment {
  assessment?: Assessment;
  diagnostics: ValidationDiagnostic[];
  resolutions: ReadonlyMap<string, ResolvedEvidence>;
}

/** Parses one JSON string token used in a bracket property selector. */
function parseQuotedProperty(
  path: string,
  start: number,
): { value: string; next: number } {
  const quote = path[start];
  let index = start + 1;
  let escaped = false;
  for (; index < path.length; index++) {
    const character = path[index];
    if (!escaped && character === quote) break;
    if (!escaped && character === "\\") escaped = true;
    else escaped = false;
  }
  if (index >= path.length || path[index] !== quote) {
    throw new Error("Unterminated JSONPath quoted property");
  }

  const raw = path.slice(start, index + 1);
  if (quote === '"') {
    try {
      return {
        value: JSON.parse(raw) as string,
        next: index + 1,
      };
    } catch {
      throw new Error("Invalid JSONPath quoted property escape");
    }
  }

  let json = '"';
  for (let cursor = 1; cursor < raw.length - 1; cursor++) {
    const character = raw[cursor];
    if (character === '"') {
      json += '\\"';
      continue;
    }
    if (character !== "\\") {
      if (character.charCodeAt(0) < 0x20) {
        throw new Error("Invalid JSONPath quoted property control character");
      }
      json += character;
      continue;
    }

    const next = raw[++cursor];
    if (next === "'") {
      json += "'";
    } else if (next === '"') {
      json += '\\"';
    } else if ("\\/bfnrt".includes(next)) {
      json += `\\${next}`;
    } else if (next === "u") {
      const digits = raw.slice(cursor + 1, cursor + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(digits)) {
        throw new Error("Invalid JSONPath Unicode escape");
      }
      json += `\\u${digits}`;
      cursor += 4;
    } else {
      throw new Error("Invalid JSONPath quoted property escape");
    }
  }
  json += '"';
  return {
    value: JSON.parse(json) as string,
    next: index + 1,
  };
}

/** Parses and canonicalizes the supported absolute single-node JSONPath subset. */
export function parseDefiniteJsonPath(path: string): ParsedJsonPath {
  if (Buffer.byteLength(path, "utf8") > MAX_JSONPATH_BYTES) {
    throw new Error(`JSONPath exceeds ${MAX_JSONPATH_BYTES} bytes`);
  }
  if (!path.startsWith("$")) throw new Error("JSONPath must start with '$'");

  const selectors: JsonPathSelector[] = [];
  let index = 1;
  while (index < path.length) {
    if (selectors.length >= MAX_JSONPATH_SELECTORS) {
      throw new Error(`JSONPath exceeds ${MAX_JSONPATH_SELECTORS} selectors`);
    }
    if (path[index] === ".") {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(path.slice(index + 1));
      if (!match) throw new Error("Invalid JSONPath property selector");
      selectors.push({ kind: "property", value: match[0] });
      index += match[0].length + 1;
      continue;
    }
    if (path[index] !== "[") {
      throw new Error(`Unsupported JSONPath token at offset ${index}`);
    }
    index++;
    if (path[index] === '"' || path[index] === "'") {
      const parsed = parseQuotedProperty(path, index);
      index = parsed.next;
      if (path[index] !== "]") {
        throw new Error("JSONPath quoted property must end with ']'");
      }
      selectors.push({ kind: "property", value: parsed.value });
      index++;
      continue;
    }
    const match = /^(0|[1-9][0-9]*)/.exec(path.slice(index));
    if (!match) throw new Error("JSONPath array index must be nonnegative");
    index += match[0].length;
    if (path[index] !== "]") {
      throw new Error("JSONPath array index must end with ']'");
    }
    selectors.push({ kind: "index", value: Number(match[0]) });
    index++;
  }

  for (const selector of selectors) {
    if (
      selector.kind === "property" &&
      forbiddenProperties.has(selector.value)
    ) {
      throw new Error(`JSONPath property '${selector.value}' is forbidden`);
    }
  }
  return {
    selectors,
    canonical: `$${selectors.map(selector => {
      if (selector.kind === "index") return `[${selector.value}]`;
      return identifier.test(selector.value)
        ? `.${selector.value}`
        : `[${JSON.stringify(selector.value)}]`;
    }).join("")}`,
  };
}

/** Resolves one parsed path through own properties only. */
function resolveJsonPath(root: unknown, path: ParsedJsonPath): unknown {
  let current = root;
  for (const selector of path.selectors) {
    if (selector.kind === "index") {
      if (!Array.isArray(current) || selector.value >= current.length) {
        throw new Error(`Array index ${selector.value} does not exist`);
      }
      current = current[selector.value];
      continue;
    }
    if (
      !current ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, selector.value)
    ) {
      throw new Error(`Property '${selector.value}' does not exist`);
    }
    current = (current as Record<string, unknown>)[selector.value];
  }
  return current;
}

/** Builds immutable structural type and ownership metadata for normalized ATIF. */
export function buildEvidenceIndex(
  atif: ScopeAtif,
): ReadonlyMap<string, ResolvedEvidence> {
  const index = new Map<string, ResolvedEvidence>();
  const callPaths = new Map<string, string>();
  const add = (
    canonicalPath: string,
    node: unknown,
    type: EvidenceType,
    ownership: Pick<
      ResolvedEvidence,
      "stepPath" | "stepIndex" | "callPath"
    >,
  ) => {
    const parsed = parseDefiniteJsonPath(canonicalPath);
    index.set(canonicalPath, {
      canonicalPath,
      selectors: parsed.selectors,
      node,
      type,
      ...ownership,
    });
  };

  atif.steps.forEach((step, stepIndex) => {
    (step.tool_calls ?? []).forEach((call, callIndex) => {
      callPaths.set(
        call.tool_call_id,
        `$.steps[${stepIndex}].tool_calls[${callIndex}]`,
      );
    });
  });

  atif.steps.forEach((step, stepIndex) => {
    const stepPath = `$.steps[${stepIndex}]`;
    add(stepPath, step, "atif.step", { stepPath, stepIndex });
    if (Array.isArray(step.message)) {
      step.message.forEach((part, partIndex) => {
        const path = `${stepPath}.message[${partIndex}]`;
        if (!contentPartSchema.safeParse(part).success) return;
        add(path, part, "atif.content_part", { stepPath, stepIndex });
        if (part.type === "image") {
          add(`${path}.source`, part.source, "atif.image_source", {
            stepPath,
            stepIndex,
          });
        } else if (part.type === "audio") {
          add(`${path}.source`, part.source, "atif.audio_source", {
            stepPath,
            stepIndex,
          });
        }
      });
    }
    (step.tool_calls ?? []).forEach((call, callIndex) => {
      const callPath = `${stepPath}.tool_calls[${callIndex}]`;
      add(callPath, call, "atif.tool_call", {
        stepPath,
        stepIndex,
        callPath,
      });
      const validation = call.extra?.scope?.input_validation;
      if (validation?.status === "invalid") {
        validation.issues.forEach((issue, issueIndex) => {
          add(
            `${callPath}.extra.scope.input_validation.issues[${issueIndex}]`,
            issue,
            "scope.input_validation_issue",
            { stepPath, stepIndex, callPath },
          );
        });
      }
    });
    (step.extra?.scope?.discoveries ?? []).forEach((discovery, discoveryIndex) => {
      add(
        `${stepPath}.extra.scope.discoveries[${discoveryIndex}]`,
        discovery,
        "scope.discovery",
        { stepPath, stepIndex },
      );
    });
    if (step.observation) {
      const observationPath = `${stepPath}.observation`;
      add(observationPath, step.observation, "atif.observation", {
        stepPath,
        stepIndex,
      });
      step.observation.results.forEach((result, resultIndex) => {
        const resultPath = `${observationPath}.results[${resultIndex}]`;
        const callPath = result.source_call_id
          ? callPaths.get(result.source_call_id)
          : undefined;
        add(resultPath, result, "atif.observation_result", {
          stepPath,
          stepIndex,
          ...(callPath ? { callPath } : {}),
        });
        if (Array.isArray(result.content)) {
          result.content.forEach((part, partIndex) => {
            const path = `${resultPath}.content[${partIndex}]`;
            if (!contentPartSchema.safeParse(part).success) return;
            add(path, part, "atif.content_part", {
              stepPath,
              stepIndex,
              ...(callPath ? { callPath } : {}),
            });
            if (part.type === "image") {
              add(`${path}.source`, part.source, "atif.image_source", {
                stepPath,
                stepIndex,
                ...(callPath ? { callPath } : {}),
              });
            } else if (part.type === "audio") {
              add(`${path}.source`, part.source, "atif.audio_source", {
                stepPath,
                stepIndex,
                ...(callPath ? { callPath } : {}),
              });
            }
          });
        }
      });
    }
  });
  return index;
}

function diagnostic(
  value: ValidationDiagnostic,
): ValidationDiagnostic {
  return value;
}

function assessmentIssues(
  candidate: unknown,
  error: z.ZodError,
): z.ZodIssue[] {
  const union = error.issues.find(
    issue => issue.code === z.ZodIssueCode.invalid_union,
  );
  if (!union || union.code !== z.ZodIssueCode.invalid_union) {
    return error.issues;
  }
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    const branch = record.observed === true
      ? 0
      : record.observed === false
        ? 1
        : record.state === "indeterminate" || record.state === "inapplicable"
        ? 2
        : undefined;
    if (branch !== undefined) {
      return union.unionErrors[branch]?.issues ?? error.issues;
    }
  }
  return union.unionErrors
    .flatMap(item => item.issues)
    .sort((left, right) => right.path.length - left.path.length);
}

function selectorEquals(
  left: JsonPathSelector,
  right: JsonPathSelector,
): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function isStrictDescendant(
  target: readonly JsonPathSelector[],
  ancestor: readonly JsonPathSelector[],
): boolean {
  return target.length > ancestor.length &&
    ancestor.every((selector, index) =>
      selectorEquals(selector, target[index])
    );
}

function immediateArrayIndex(
  value: ResolvedEvidence,
  axis: ParsedJsonPath,
): number | undefined {
  if (!isStrictDescendant(value.selectors, axis.selectors)) return undefined;
  const child = value.selectors[axis.selectors.length];
  return child?.kind === "index" ? child.value : undefined;
}

/** Validates the shared assessment, evidence roles, paths, types, and constraints. */
export function validateAssessment(
  value: unknown,
  contract: EvidenceContract,
  atif: ScopeAtif,
): ValidatedAssessment {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return {
        diagnostics: [{
          code: "invalid_json",
          output_path: "$",
          message: "Producer output is not valid JSON",
        }],
        resolutions: new Map(),
      };
    }

  }
  const parsed = assessmentSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      diagnostics: assessmentIssues(candidate, parsed.error)
        .slice(0, 100).map(issue =>
        diagnostic({
          code: "schema_mismatch",
          output_path: `$${issue.path.map(segment =>
            typeof segment === "number" ? `[${segment}]` : `.${segment}`
          ).join("")}`,
          message: issue.message,
        })
      ),
      resolutions: new Map(),
    };
  }

  const assessment = parsed.data;
  if (assessment.state !== "completed" || assessment.observed !== true) {
    return { assessment, diagnostics: [], resolutions: new Map() };
  }

  const diagnostics: ValidationDiagnostic[] = [];
  const evidenceIndex = buildEvidenceIndex(atif);
  const resolutions = new Map<string, ResolvedEvidence>();
  let referenceCount = 0;

  assessment.occurrences.forEach((occurrence, occurrenceIndex) => {
    const byRole = new Map<string, ResolvedEvidence[]>();
    const duplicateKeys = new Set<string>();
    const invalidRoles = new Set<string>();
    occurrence.evidence.forEach((reference, referenceIndex) => {
      referenceCount++;
      const outputPath =
        `$.occurrences[${occurrenceIndex}].evidence[${referenceIndex}]`;
      const declared = contract.evidence_roles[reference.role];
      if (!declared) {
        diagnostics.push(diagnostic({
          code: "unknown_role",
          output_path: `${outputPath}.role`,
          role: reference.role,
          message: `Role '${reference.role}' is not declared`,
        }));
        return;
      }

      let parsedPath: ParsedJsonPath;
      try {
        parsedPath = parseDefiniteJsonPath(reference.path);
      } catch (error) {
        invalidRoles.add(reference.role);
        diagnostics.push(diagnostic({
          code: "invalid_jsonpath",
          output_path: `${outputPath}.path`,
          role: reference.role,
          evidence_path: reference.path,
          message: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      const duplicateKey = `${reference.role}\0${parsedPath.canonical}`;
      if (duplicateKeys.has(duplicateKey)) {
        invalidRoles.add(reference.role);
        diagnostics.push(diagnostic({
          code: "duplicate_reference",
          output_path: outputPath,
          role: reference.role,
          evidence_path: parsedPath.canonical,
          message: "Duplicate role/path reference",
        }));
        return;
      }
      duplicateKeys.add(duplicateKey);

      try {
        resolveJsonPath(atif, parsedPath);
      } catch (error) {
        invalidRoles.add(reference.role);
        diagnostics.push(diagnostic({
          code: "unresolved_reference",
          output_path: `${outputPath}.path`,
          role: reference.role,
          evidence_path: parsedPath.canonical,
          message: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      const resolution = evidenceIndex.get(parsedPath.canonical);
      if (!resolution?.type) {
        invalidRoles.add(reference.role);
        diagnostics.push(diagnostic({
          code: "reference_type_mismatch",
          output_path: `${outputPath}.path`,
          role: reference.role,
          evidence_path: parsedPath.canonical,
          expected_type: declared.type,
          message: "Resolved node is not a registered evidence type",
        }));
        return;
      }
      if (resolution.type !== declared.type) {
        invalidRoles.add(reference.role);
        diagnostics.push(diagnostic({
          code: "reference_type_mismatch",
          output_path: `${outputPath}.path`,
          role: reference.role,
          evidence_path: parsedPath.canonical,
          expected_type: declared.type,
          actual_type: resolution.type,
        }));
        return;
      }
      const values = byRole.get(reference.role) ?? [];
      values.push(resolution);
      byRole.set(reference.role, values);
      resolutions.set(
        `${occurrenceIndex}\0${reference.role}\0${parsedPath.canonical}`,
        resolution,
      );
    });

    for (const [role, declared] of Object.entries(contract.evidence_roles)) {
      if (invalidRoles.has(role)) continue;
      const count = byRole.get(role)?.length ?? 0;
      if (count < declared.min || (
        declared.max !== undefined && count > declared.max
      )) {
        diagnostics.push(diagnostic({
          code: "role_cardinality",
          output_path: `$.occurrences[${occurrenceIndex}].evidence`,
          role,
          expected_type: declared.type,
          message: `Role '${role}' expected ${declared.min}..${declared.max ?? "unbounded"} references, got ${count}`,
        }));
      }
    }

    for (const constraint of contract.constraints) {
      const roleValues = byRole.get(constraint.role) ?? [];
      if (!roleValues.length) continue;
      if (constraint.kind === "owned_by") {
        const owners = new Set(
          (byRole.get(constraint.owner_role) ?? [])
            .map(value => value.callPath)
            .filter((value): value is string => Boolean(value)),
        );
        for (const value of roleValues) {
          if (!value.callPath || !owners.has(value.callPath)) {
            diagnostics.push(diagnostic({
              code: "reference_constraint_mismatch",
              output_path: `$.occurrences[${occurrenceIndex}].evidence`,
              role: constraint.role,
              evidence_path: value.canonicalPath,
              message: `Role '${constraint.role}' is not owned by '${constraint.owner_role}'`,
            }));
          }
        }
      } else if (constraint.kind === "descendant_of") {
        const references = byRole.get(constraint.reference_role) ?? [];
        for (const value of roleValues) {
          if (!references.some(reference =>
            isStrictDescendant(value.selectors, reference.selectors)
          )) {
            diagnostics.push(diagnostic({
              code: "reference_constraint_mismatch",
              output_path: `$.occurrences[${occurrenceIndex}].evidence`,
              role: constraint.role,
              evidence_path: value.canonicalPath,
              message: `Role '${constraint.role}' must be a strict descendant of '${constraint.reference_role}'`,
            }));
          }
        }
      } else {
        const references = byRole.get(constraint.reference_role) ?? [];
        if (!references.length) continue;
        let axis: ParsedJsonPath;
        try {
          axis = parseDefiniteJsonPath(constraint.within);
        } catch (error) {
          diagnostics.push(diagnostic({
            code: "reference_constraint_mismatch",
            output_path: `$.occurrences[${occurrenceIndex}].evidence`,
            role: constraint.role,
            evidence_path: constraint.within,
            message: `Constraint axis is invalid: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }));
          continue;
        }
        let axisValue: unknown;
        try {
          axisValue = resolveJsonPath(atif, axis);
        } catch (error) {
          diagnostics.push(diagnostic({
            code: "reference_constraint_mismatch",
            output_path: `$.occurrences[${occurrenceIndex}].evidence`,
            role: constraint.role,
            evidence_path: axis.canonical,
            message: `Constraint axis does not resolve: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }));
          continue;
        }
        if (!Array.isArray(axisValue)) {
          diagnostics.push(diagnostic({
            code: "reference_constraint_mismatch",
            output_path: `$.occurrences[${occurrenceIndex}].evidence`,
            role: constraint.role,
            evidence_path: axis.canonical,
            message: "Constraint axis must resolve to an array",
          }));
          continue;
        }
        const referenceIndices = references.map(reference =>
          immediateArrayIndex(reference, axis)
        );
        for (const value of roleValues) {
          const targetIndex = immediateArrayIndex(value, axis);
          if (
            targetIndex === undefined ||
            referenceIndices.some(referenceIndex =>
              referenceIndex === undefined || targetIndex <= referenceIndex
            )
          ) {
            diagnostics.push(diagnostic({
              code: "reference_constraint_mismatch",
              output_path: `$.occurrences[${occurrenceIndex}].evidence`,
              role: constraint.role,
              evidence_path: value.canonicalPath,
              message:
                `Role '${constraint.role}' must be strictly after every ` +
                `'${constraint.reference_role}' reference within ${axis.canonical}`,
            }));
          }
        }
      }
    }
  });

  if (referenceCount > MAX_ASSESSMENT_REFERENCES) {
    diagnostics.push(diagnostic({
      code: "schema_mismatch",
      output_path: "$.occurrences",
      message: `Assessment exceeds ${MAX_ASSESSMENT_REFERENCES} total references`,
    }));
  }
  return {
    assessment: diagnostics.length ? undefined : assessment,
    diagnostics: diagnostics.slice(0, 100),
    resolutions,
  };
}

/**
 * Validates an assessment already decoded by the producer's JSON wire parser.
 * A string is a wrong envelope type here and is never decoded a second time.
 */
export function validateParsedAssessment(
  value: unknown,
  contract: EvidenceContract,
  atif: ScopeAtif,
): ValidatedAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      diagnostics: [{
        code: "schema_mismatch",
        output_path: "$",
        message:
          "Parsed observation must be one assessment object, not an encoded string or wrapper.",
      }],
      resolutions: new Map(),
    };
  }
  return validateAssessment(value, contract, atif);
}
