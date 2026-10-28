// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Assessment } from "../assessment.js";
import type { ScopeAtif } from "../scope-atif.js";

/** Returns whether Scope recorded at least one discovery event. */
export function hasRecordedDiscovery(atif: ScopeAtif): boolean {
  return atif.steps.some(step =>
    (step.extra?.scope?.discoveries?.length ?? 0) > 0
  );
}

/** Applies the prompt-only complete-trace no-discovery negative shortcut. */
export function requiresRecordedDiscovery(
  enabled: boolean,
  implementation: "prompt" | "deterministic",
  atif: ScopeAtif,
): Assessment | undefined {
  const trajectoryState =
    atif.extra?.scope?.trajectory_state ?? "complete";
  if (
    !enabled ||
    implementation !== "prompt" ||
    trajectoryState !== "complete" ||
    hasRecordedDiscovery(atif)
  ) {
    return undefined;
  }
  return { state: "completed", observed: false };
}
