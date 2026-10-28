// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { canonicalJsonSha256 } from "../canonical-json.js";

/** Effective validation/upcast policy included in compatibility fingerprints. */
export const ATIF_INGESTION_POLICY = {
  accepted_source_versions: ["ATIF-v1.6", "ATIF-v1.7", "ATIF-v1.8"],
  canonical_target: "ATIF-v1.8",
  strict_official_core: true,
  root_container: "object-or-singleton-object-array",
  upcasters: ["v1.6-to-v1.7", "v1.7-to-v1.8"],
  scope_extension_namespace: "extra.scope",
  source_mapping: "original-jsonpath-v1",
  semantic_validation_locations: true,
  archive_component_history: true,
  persisted_provenance_metadata: true,
} as const;

export const ATIF_INGESTION_POLICY_HASH = canonicalJsonSha256(
  ATIF_INGESTION_POLICY,
);
