// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Assessment } from "../assessment.js";
import {
  atifContentText,
  type ScopeAtif,
} from "../scope-atif.js";

/** Checks the existing task-context presence heuristic without semantic extraction. */
export function hasTaskContext(atif: ScopeAtif): boolean {
  return Boolean(
    atif.extra?.scope?.task ||
    atif.steps.some(step =>
      step.source === "user" && atifContentText(step.message).trim()
    ),
  );
}

/** Blocks evaluation when task-context presence is required but absent. */
export function requiresTask(
  enabled: boolean,
  atif: ScopeAtif,
  elementLabel: string,
): Assessment | undefined {
  if (!enabled || hasTaskContext(atif)) return undefined;
  return {
    state: "indeterminate",
    reason: `${elementLabel} requires task evidence to assess relevance.`,
  };
}
