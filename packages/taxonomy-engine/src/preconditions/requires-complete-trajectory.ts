// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Assessment } from "../assessment.js";
import type { ScopeAtif } from "../scope-atif.js";

/** Blocks the entire element evaluation when a complete trajectory is required. */
export function requiresCompleteTrajectory(
  enabled: boolean,
  atif: ScopeAtif,
  elementLabel: string,
): Assessment | undefined {
  const trajectoryState =
    atif.extra?.scope?.trajectory_state ?? "complete";
  if (!enabled || trajectoryState === "complete") return undefined;
  return {
    state: "indeterminate",
    reason:
      `${elementLabel} requires complete trajectory evidence for absence conclusions.`,
  };
}
