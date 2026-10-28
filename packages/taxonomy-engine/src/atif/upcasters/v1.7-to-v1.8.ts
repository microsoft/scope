// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AtifV17 } from "../validators/v1.7.js";
import type { AtifV16 } from "../validators/v1.6.js";
import type { AtifProvenance } from "../types.js";
import {
  upcastOwnedV16ToV17,
  upcastV16ToV17,
} from "./v1.6-to-v1.7.js";

function canonicalizeEmbedded(
  input: Record<string, unknown>,
  provenance: AtifProvenance,
  normalizedPath: string,
  originalPath: string,
  copySource: boolean,
): { value: Record<string, unknown>; provenance: AtifProvenance } {
  const version = input.schema_version;
  if (version === "ATIF-v1.6") {
    const first = (copySource
      ? upcastV16ToV17
      : upcastOwnedV16ToV17)(
      input as AtifV16,
      provenance,
      { normalized: normalizedPath, original: originalPath },
    );
    return canonicalizeEmbedded(
      first.value as Record<string, unknown>,
      first.provenance,
      normalizedPath,
      originalPath,
      false,
    );
  }
  if (version === "ATIF-v1.7") {
    const result = upcastV17ToV18Internal(
      input as AtifV17,
      provenance,
      { normalized: normalizedPath, original: originalPath },
      copySource,
    );
    return {
      value: result.value as Record<string, unknown>,
      provenance: result.provenance,
    };
  }
  const value = copySource ? structuredClone(input) : input;
  let nextProvenance = provenance;
  const children = value.subagent_trajectories;
  if (Array.isArray(children)) {
    value.subagent_trajectories = children.map((child, index) => {
      const result = canonicalizeEmbedded(
        child as Record<string, unknown>,
        nextProvenance,
        `${normalizedPath}.subagent_trajectories[${index}]`,
        `${originalPath}.subagent_trajectories[${index}]`,
        false,
      );
      nextProvenance = result.provenance;
      return result.value;
    });
  }
  return { value, provenance: nextProvenance };
}

function upcastV17ToV18Internal(
  source: AtifV17,
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
  value.schema_version = "ATIF-v1.8";
  let nextProvenance: AtifProvenance = {
    ...provenance,
    upcasters: [...provenance.upcasters, {
      name: "v1.7-to-v1.8",
      source_version: "ATIF-v1.7",
      target_version: "ATIF-v1.8",
    }],
    mappings: [...provenance.mappings, {
      normalized_prefix: `${path.normalized}.schema_version`,
      original_prefix: `${path.original}.schema_version`,
      generated_by: "v1.7-to-v1.8",
    }],
  };
  const children = value.subagent_trajectories;
  if (Array.isArray(children)) {
    value.subagent_trajectories = children.map((child, index) => {
      const result = canonicalizeEmbedded(
        child as Record<string, unknown>,
        nextProvenance,
        `${path.normalized}.subagent_trajectories[${index}]`,
        `${path.original}.subagent_trajectories[${index}]`,
        false,
      );
      nextProvenance = result.provenance;
      return result.value;
    });
  }
  return {
    value,
    provenance: nextProvenance,
  };
}

/** Pure adjacent v1.7→v1.8 upcaster preserving all recorded values/order. */
export function upcastV17ToV18(
  source: AtifV17,
  provenance: AtifProvenance,
  path: {
    normalized: string;
    original: string;
  } = {
    normalized: "$",
    original: provenance.container_prefix,
  },
): { value: unknown; provenance: AtifProvenance } {
  return upcastV17ToV18Internal(source, provenance, path, true);
}

/** Upcasts a validation-owned document in place to avoid another tree copy. */
export function upcastOwnedV17ToV18(
  source: AtifV17,
  provenance: AtifProvenance,
  path: {
    normalized: string;
    original: string;
  } = {
    normalized: "$",
    original: provenance.container_prefix,
  },
): { value: unknown; provenance: AtifProvenance } {
  return upcastV17ToV18Internal(source, provenance, path, false);
}

/** Canonicalizes embedded supported trajectories under an already-v1.8 root. */
export function canonicalizeV18EmbeddedTrajectories(
  source: Record<string, unknown>,
  provenance: AtifProvenance,
): { value: unknown; provenance: AtifProvenance } {
  return canonicalizeEmbedded(
    source,
    provenance,
    "$",
    provenance.container_prefix,
    true,
  );
}

/** Canonicalizes children inside a validation-owned v1.8 document in place. */
export function canonicalizeOwnedV18EmbeddedTrajectories(
  source: Record<string, unknown>,
  provenance: AtifProvenance,
): { value: unknown; provenance: AtifProvenance } {
  return canonicalizeEmbedded(
    source,
    provenance,
    "$",
    provenance.container_prefix,
    false,
  );
}
