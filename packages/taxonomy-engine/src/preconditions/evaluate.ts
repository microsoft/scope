// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Assessment } from "../assessment.js";
import type { ScopeAtif } from "../scope-atif.js";
import { requiresCompleteTrajectory } from "./requires-complete-trajectory.js";
import { requiresRecordedDiscovery } from "./requires-recorded-discovery.js";
import { requiresTask } from "./requires-task.js";
import type { ElementPreconditions } from "./schema.js";

/** Minimal element metadata needed by ordered precondition evaluation. */
export interface PreconditionsElement {
  label: string;
  implementation: { type: "prompt" | "deterministic" };
  preconditions: ElementPreconditions;
}

/** Evaluates completeness, task, then discovery without I/O or model calls. */
export function evaluatePreconditions(
  atif: ScopeAtif,
  element: PreconditionsElement,
): Assessment | undefined {
  return requiresCompleteTrajectory(
    element.preconditions.requires_complete_trajectory,
    atif,
    element.label,
  ) ?? requiresTask(
    element.preconditions.requires_task,
    atif,
    element.label,
  ) ?? requiresRecordedDiscovery(
    element.preconditions.requires_recorded_discovery,
    element.implementation.type,
    atif,
  );
}
