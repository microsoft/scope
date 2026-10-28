// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ingestAtif,
  AtifIngestionError,
  createAtifProvenance,
  originalAtifPath,
  SCOPE_ATIF_EXTENSION_VERSION,
  type AtifAudioSource,
  type AtifContentPart,
  type AtifImageSource,
  type AtifProvenance,
  type AtifSourceDescriptor,
  type ScopeAtif,
  type ScopeDiscovery,
  type ScopeInputValidationIssue,
  type ScopeSource,
  contentPartSchema,
} from "./atif/index.js";
import type { NormalizedTaxonomy } from "./taxonomy.js";

export {
  SCOPE_ATIF_EXTENSION_VERSION,
  type AtifAudioSource,
  type AtifContentPart,
  type AtifImageSource,
  type ScopeAtif,
  type ScopeDiscovery,
  type ScopeInputValidationIssue,
  type ScopeSource,
  contentPartSchema,
};

export type ScopeAtifStep = ScopeAtif["steps"][number];
export type ScopeToolCall =
  NonNullable<ScopeAtifStep["tool_calls"]>[number];
export type ScopeObservation =
  NonNullable<ScopeAtifStep["observation"]>;
export type ScopeObservationResult =
  ScopeObservation["results"][number];

/** Runtime input shared by prompt and deterministic element execution. */
export interface TaxonomyInput {
  /** Frozen canonical normalized ATIF-v1.8 evidence stream. */
  atif: ScopeAtif;
  /** Optional original-source provenance retained outside evidence. */
  atif_provenance?: AtifProvenance;
  /** Frozen loaded taxonomy and resolved private implementations. */
  taxonomy: NormalizedTaxonomy;
}

/** Returns text portions without flattening or mutating multimodal content. */
export function atifContentText(
  value: string | AtifContentPart[] | unknown,
): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(part =>
    part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
      ? [part.text]
      : []
  ).join("\n");
}

/** Ingests one memory value and returns canonical normalized ATIF-v1.8. */
export function parseScopeAtif(
  value: unknown,
  source: AtifSourceDescriptor = { label: "<memory>" },
): ScopeAtif {
  return ingestAtif(value, source).atif;
}

/** Validates taxonomy-specific Scope surfaces and global normalized call links. */
export function validateScopeAtif(
  atif: ScopeAtif,
  taxonomy: NormalizedTaxonomy,
  provenance: AtifProvenance = createAtifProvenance(
    { label: "<memory>" },
    "$",
    "ATIF-v1.8",
  ),
): void {
  const fail = (
    code: string,
    normalizedPath: string,
    message: string,
  ): never => {
    const original = originalAtifPath(provenance, normalizedPath);
    throw new AtifIngestionError({
      code,
      stage: "source_validation",
      message,
      ...(original.source ?? provenance.source),
      original_path: original.path,
      normalized_path: normalizedPath,
      source_version: provenance.source_version,
      target_version: "ATIF-v1.8",
      ...(original.generated_by
        ? { generated_by: original.generated_by }
        : {}),
    });
  };
  const sources = atif.extra?.scope?.available_sources ?? [];
  const sourceIds = new Set<string>();
  for (const [sourceIndex, source] of sources.entries()) {
    if (sourceIds.has(source.id)) {
      fail(
        "atif_duplicate_scope_source",
        `$.extra.scope.available_sources[${sourceIndex}].id`,
        `Duplicate Scope source ID '${source.id}'.`,
      );
    }
    if (!taxonomy.surfaceById.has(source.surface_id)) {
      fail(
        "atif_unknown_scope_surface",
        `$.extra.scope.available_sources[${sourceIndex}].surface_id`,
        `Scope source '${source.id}' references unknown surface '${source.surface_id}'`,
      );
    }
    sourceIds.add(source.id);
  }

  const callIds = new Set<string>();
  for (const [stepIndex, step] of atif.steps.entries()) {
    for (const [callIndex, call] of (
      step.tool_calls ?? []
    ).entries()) {
      if (callIds.has(call.tool_call_id)) {
        fail(
          "atif_duplicate_tool_call",
          `$.steps[${stepIndex}].tool_calls[${callIndex}].tool_call_id`,
          `Duplicate ATIF tool call ID '${call.tool_call_id}'.`,
        );
      }
      callIds.add(call.tool_call_id);
      const sourceId = call.extra?.scope?.source_id;
      if (sourceId && !sourceIds.has(sourceId)) {
        fail(
          "atif_undeclared_call_source",
          `$.steps[${stepIndex}].tool_calls[${callIndex}].extra.scope.source_id`,
          `Tool call '${call.tool_call_id}' references undeclared source '${sourceId}'.`,
        );
      }
    }
  }

  for (const [stepIndex, step] of atif.steps.entries()) {
    for (const [discoveryIndex, discovery] of (
      step.extra?.scope?.discoveries ?? []
    ).entries()) {
      if (!sourceIds.has(discovery.source_id)) {
        fail(
          "atif_undeclared_discovery_source",
          `$.steps[${stepIndex}].extra.scope.discoveries[${discoveryIndex}].source_id`,
          `Discovery at step ${step.step_id} references undeclared source '${discovery.source_id}'.`,
        );
      }
    }
    for (const [resultIndex, result] of (
      step.observation?.results ?? []
    ).entries()) {
      if (result.source_call_id && !callIds.has(result.source_call_id)) {
        fail(
          "atif_unknown_observation_call",
          `$.steps[${stepIndex}].observation.results[${resultIndex}].source_call_id`,
          `Observation references unknown tool call '${result.source_call_id}'.`,
        );
      }
    }
  }
}

/** Recursively freezes evidence before any trusted implementation receives it. */
export function freezeTaxonomyInput<Input>(input: Input): Input {
  const visited = new Set<object>();
  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  freeze(input);
  return input;
}
