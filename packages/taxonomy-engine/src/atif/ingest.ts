// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { boundedErrorMessage } from "../errors.js";
import {
  normalizeOwnedScopeExtensions,
  type ScopeAtif,
} from "./scope-extensions.js";
import { createAtifProvenance, originalAtifPath } from "./source-map.js";
import {
  type AtifV18Canonical,
  AtifIngestionError,
  type AtifIngestionDiagnostic,
  type AtifIngestionResult,
  type AtifSourceDescriptor,
  type AtifSourceMapping,
  type AtifSourceVersion,
} from "./types.js";
import {
  upcastOwnedV16ToV17,
} from "./upcasters/v1.6-to-v1.7.js";
import {
  canonicalizeOwnedV18EmbeddedTrajectories,
  upcastOwnedV17ToV18,
} from "./upcasters/v1.7-to-v1.8.js";
import { atifV16Schema } from "./validators/v1.6.js";
import { atifV17Schema } from "./validators/v1.7.js";
import type { AtifV17 } from "./validators/v1.7.js";
import {
  atifV18Schema,
  canonicalAtifV18Schema,
} from "./validators/v1.8.js";
import { detachParsedAtifOpaqueValues } from "./ownership.js";

const versions = new Set<AtifSourceVersion>([
  "ATIF-v1.6",
  "ATIF-v1.7",
  "ATIF-v1.8",
]);

function sourceDetails(source: AtifSourceDescriptor) {
  return {
    ...(source.file ? { file: source.file } : {}),
    ...(source.archive_entry
      ? { archive_entry: source.archive_entry }
      : {}),
    ...(source.jsonl_line ? { jsonl_line: source.jsonl_line } : {}),
  };
}

function issuePath(issue: z.ZodIssue): string {
  return `$${issue.path.map(segment =>
    typeof segment === "number"
      ? `[${segment}]`
      : /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(segment))
        ? `.${String(segment)}`
        : `[${JSON.stringify(String(segment))}]`
  ).join("")}`;
}

function diagnosticIssue(error: z.ZodError): z.ZodIssue {
  const flatten = (issue: z.ZodIssue): z.ZodIssue[] => {
    if (issue.code !== z.ZodIssueCode.invalid_union) return [issue];
    return issue.unionErrors.flatMap(unionError =>
      unionError.issues.flatMap(flatten)
    );
  };
  return error.issues
    .flatMap(flatten)
    .sort((left, right) =>
      right.path.length - left.path.length ||
      Number(left.message === "Invalid input") -
        Number(right.message === "Invalid input")
    )[0] ?? error.issues[0];
}

function throwValidation(
  error: z.ZodError,
  stage: AtifIngestionDiagnostic["stage"],
  provenance: ReturnType<typeof createAtifProvenance>,
  sourceVersion: AtifSourceVersion,
  targetVersion?: AtifSourceVersion,
  upcaster?: string,
): never {
  const issue = diagnosticIssue(error);
  const normalizedPath = issuePath(issue);
  const original = originalAtifPath(provenance, normalizedPath);
  throw new AtifIngestionError({
    code: stage === "source_validation"
      ? "atif_invalid_source"
      : "atif_invalid_target",
    stage,
    message: boundedErrorMessage(issue.message),
    ...sourceDetails(original.source ?? provenance.source),
    original_path: original.path,
    normalized_path: normalizedPath,
    source_version: sourceVersion,
    ...(targetVersion ? { target_version: targetVersion } : {}),
    ...(upcaster ? { upcaster } : {}),
    ...(original.generated_by
      ? { generated_by: original.generated_by }
      : {}),
  });
}

function unwrapContainer(
  value: unknown,
  source: AtifSourceDescriptor,
): { value: Record<string, unknown>; prefix: string } {
  const root = source.json_path_prefix ?? "$";
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new AtifIngestionError({
        code: "atif_invalid_container",
        stage: "container",
        message:
          `ATIF root array must contain exactly one trajectory; got ${value.length}.`,
        ...sourceDetails(source),
        original_path: root,
      });
    }
    if (
      !value[0] ||
      typeof value[0] !== "object" ||
      Array.isArray(value[0])
    ) {
      throw new AtifIngestionError({
        code: "atif_invalid_container",
        stage: "container",
        message: "ATIF singleton array entry must be an object.",
        ...sourceDetails(source),
        original_path: `${root}[0]`,
      });
    }
    return {
      value: value[0] as Record<string, unknown>,
      prefix: `${root}[0]`,
    };
  }
  if (!value || typeof value !== "object") {
    throw new AtifIngestionError({
      code: "atif_invalid_container",
      stage: "container",
      message: "ATIF root must be an object or singleton object array.",
      ...sourceDetails(source),
      original_path: root,
    });
  }
  return { value: value as Record<string, unknown>, prefix: root };
}

/** Parses JSON text and ingests one ATIF document with original-source mapping. */
export function ingestAtifJson(
  text: string,
  source: AtifSourceDescriptor = { label: "<memory>" },
): AtifIngestionResult<ScopeAtif> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new AtifIngestionError({
      code: "atif_invalid_json",
      stage: "decoding",
      message: boundedErrorMessage(error),
      ...sourceDetails(source),
      original_path: source.json_path_prefix ?? "$",
    });
  }
  return ingestAtif(value, source);
}

/** Validates, adjacent-upcasts, Scope-normalizes, and returns canonical v1.8. */
export function ingestAtif(
  raw: unknown,
  source: AtifSourceDescriptor = { label: "<memory>" },
  initialMappings: readonly AtifSourceMapping[] = [],
): AtifIngestionResult<ScopeAtif> {
  const container = unwrapContainer(raw, source);
  const declared = container.value.schema_version;
  if (typeof declared !== "string" || !versions.has(
    declared as AtifSourceVersion,
  )) {
    throw new AtifIngestionError({
      code: "atif_unsupported_version",
      stage: "version",
      message:
        "Expected declared schema_version ATIF-v1.6, ATIF-v1.7, or ATIF-v1.8.",
      ...sourceDetails(source),
      original_path: `${container.prefix}.schema_version`,
    });
  }
  const sourceVersion = declared as AtifSourceVersion;
  let provenance = createAtifProvenance(
    source,
    container.prefix,
    sourceVersion,
  );
  provenance = {
    ...provenance,
    mappings: [...provenance.mappings, ...initialMappings],
  };
  let current: unknown = container.value;

  if (sourceVersion === "ATIF-v1.6") {
    const parsed = atifV16Schema.safeParse(current);
    if (!parsed.success) {
      throwValidation(
        parsed.error,
        "source_validation",
        provenance,
        sourceVersion,
      );
    }
    detachParsedAtifOpaqueValues(
      parsed.data as Record<string, unknown>,
    );
    const upcast = upcastOwnedV16ToV17(parsed.data, provenance);
    current = upcast.value;
    provenance = upcast.provenance;
    const target = atifV17Schema.safeParse(current);
    if (!target.success) {
      throwValidation(
        target.error,
        "target_validation",
        provenance,
        sourceVersion,
        "ATIF-v1.7",
        "v1.6-to-v1.7",
      );
    }
    current = target.data;
  } else if (sourceVersion === "ATIF-v1.7") {
    const parsed = atifV17Schema.safeParse(current);
    if (!parsed.success) {
      throwValidation(
        parsed.error,
        "source_validation",
        provenance,
        sourceVersion,
      );
    }
    detachParsedAtifOpaqueValues(
      parsed.data as Record<string, unknown>,
    );
    current = parsed.data;
  } else {
    const parsed = atifV18Schema.safeParse(current);
    if (!parsed.success) {
      throwValidation(
        parsed.error,
        "source_validation",
        provenance,
        sourceVersion,
      );
    }
    detachParsedAtifOpaqueValues(
      parsed.data as Record<string, unknown>,
    );
    current = parsed.data;
  }

  if (sourceVersion !== "ATIF-v1.8") {
    const upcast = upcastOwnedV17ToV18(
      current as AtifV17,
      provenance,
    );
    current = upcast.value;
    provenance = upcast.provenance;
  } else {
    const canonicalized = canonicalizeOwnedV18EmbeddedTrajectories(
      current as Record<string, unknown>,
      provenance,
    );
    current = canonicalized.value;
    provenance = canonicalized.provenance;
  }

  const target = canonicalAtifV18Schema.safeParse(current);
  if (!target.success) {
    throwValidation(
      target.error,
      sourceVersion === "ATIF-v1.8"
        ? "source_validation"
        : "target_validation",
      provenance,
      sourceVersion,
      "ATIF-v1.8",
      sourceVersion === "ATIF-v1.6"
        ? "v1.7-to-v1.8"
        : sourceVersion === "ATIF-v1.7"
          ? "v1.7-to-v1.8"
          : undefined,
    );
  }
  let normalized;
  try {
    normalized = normalizeOwnedScopeExtensions(
      target.data as AtifV18Canonical,
      provenance,
    );
  } catch (error) {
    if (error instanceof AtifIngestionError) throw error;
    throw new AtifIngestionError({
      code: "atif_invalid_scope_extension",
      stage: "scope_normalization",
      message: boundedErrorMessage(error),
      ...sourceDetails(source),
      original_path: container.prefix,
      source_version: sourceVersion,
      target_version: "ATIF-v1.8",
    });
  }
  const finalTarget = canonicalAtifV18Schema.safeParse(normalized.atif);
  if (!finalTarget.success) {
    throwValidation(
      finalTarget.error,
      "scope_normalization",
      normalized.provenance,
      sourceVersion,
      "ATIF-v1.8",
    );
  }
  return {
    atif: normalized.atif,
    provenance: normalized.provenance,
  };
}
