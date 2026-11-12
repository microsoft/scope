// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AtifV16 } from "../validators/v1.6.js";
import type { AtifV17 } from "../validators/v1.7.js";
import {
  AtifIngestionError,
  type AtifProvenance,
} from "../types.js";

function upcastV16ToV17Internal(
  source: AtifV16,
  provenance: AtifProvenance,
  path: {
    normalized: string;
    original: string;
  },
  copySource: boolean,
): { value: unknown; provenance: AtifProvenance } {
  const value = (
    copySource ? structuredClone(source) : source
  ) as Record<string, unknown>;
  value.schema_version = "ATIF-v1.7";
  const steps = value.steps as Array<Record<string, unknown>>;
  for (const [stepIndex, step] of steps.entries()) {
    const observation = step.observation as
      | { results?: Array<Record<string, unknown>> }
      | undefined;
    for (const [resultIndex, result] of (
      observation?.results ?? []
    ).entries()) {
      const references = result.subagent_trajectory_ref as
        | Array<Record<string, unknown>>
        | undefined;
      for (const [referenceIndex, reference] of (
        references ?? []
      ).entries()) {
        if (!reference.trajectory_path) {
          throw new AtifIngestionError({
            code: "atif_upcast_unresolvable_subagent",
            stage: "upcasting",
            message:
              "ATIF-v1.6 session-only subagent reference cannot be safely " +
              "upcast without trajectory_path or an unambiguous supplied target.",
            ...provenance.source,
            original_path:
              `${path.original}.steps[${stepIndex}].observation.results[${resultIndex}].subagent_trajectory_ref[${referenceIndex}]`,
            source_version: "ATIF-v1.6",
            target_version: "ATIF-v1.7",
            upcaster: "v1.6-to-v1.7",
          });
        }
      }
    }
  }
  return {
    value,
    provenance: {
      ...provenance,
      upcasters: [...provenance.upcasters, {
        name: "v1.6-to-v1.7",
        source_version: "ATIF-v1.6",
        target_version: "ATIF-v1.7",
      }],
      mappings: [...provenance.mappings, {
        normalized_prefix: `${path.normalized}.schema_version`,
        original_prefix: `${path.original}.schema_version`,
        generated_by: "v1.6-to-v1.7",
      }],
    },
  };
}

/** Pure adjacent v1.6→v1.7 upcaster; invalid legacy links fail explicitly. */
export function upcastV16ToV17(
  source: AtifV16,
  provenance: AtifProvenance,
  path: {
    normalized: string;
    original: string;
  } = {
    normalized: "$",
    original: provenance.container_prefix,
  },
): { value: unknown; provenance: AtifProvenance } {
  return upcastV16ToV17Internal(source, provenance, path, true);
}

/** Upcasts a validation-owned document in place to avoid another tree copy. */
export function upcastOwnedV16ToV17(
  source: AtifV16,
  provenance: AtifProvenance,
  path: {
    normalized: string;
    original: string;
  } = {
    normalized: "$",
    original: provenance.container_prefix,
  },
): { value: unknown; provenance: AtifProvenance } {
  return upcastV16ToV17Internal(source, provenance, path, false);
}
