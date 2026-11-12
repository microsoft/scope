// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  NORMALIZED_ATIF_VERSION,
  type InputIdentity,
} from "./assessment.js";
import { canonicalJsonSha256 } from "./canonical-json.js";
import type { ScopeAtif } from "./scope-atif.js";

/** Optional source identity retained alongside the authoritative fingerprint. */
export interface InputIdentityContext {
  archiveRoot?: string;
  requestId?: string;
  runId?: string;
}

/** Computes exact normalized-ATIF identity without assuming session uniqueness. */
export function createInputIdentity(
  atif: ScopeAtif,
  context: InputIdentityContext = {},
): InputIdentity {
  const scopeRun = atif.extra?.scope?.run;
  return {
    normalization: NORMALIZED_ATIF_VERSION,
    sha256: canonicalJsonSha256(atif),
    ...(atif.trajectory_id ? { trajectory_id: atif.trajectory_id } : {}),
    ...(atif.session_id ? { session_id: atif.session_id } : {}),
    ...(context.requestId ?? scopeRun?.request_id
      ? { request_id: context.requestId ?? scopeRun?.request_id }
      : {}),
    ...(context.runId ?? scopeRun?.id
      ? { run_id: context.runId ?? scopeRun?.id }
      : {}),
    ...(context.archiveRoot ? { archive_root: context.archiveRoot } : {}),
  };
}
