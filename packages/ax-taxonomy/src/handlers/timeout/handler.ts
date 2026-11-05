// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import type {
  Assessment,
  DeterministicHandler,
  TaxonomyInput as LoadedTaxonomyInput,
} from "taxonomy-engine";

export const timeoutConfigSchema = z.object({
  threshold_ms: z.number().finite().positive().optional(),
}).strict();
export type TimeoutConfig = z.infer<typeof timeoutConfigSchema>;

/**
 * Pure built-in Timeout handler over namespaced Scope call evidence.
 *
 * @param input - Frozen stitched/plain ATIF plus loaded taxonomy.
 * @param config - YAML policy; `threshold_ms` is optional milliseconds.
 */
function evaluateTimeout(
  input: LoadedTaxonomyInput,
  config: TimeoutConfig,
): Assessment {
  const occurrences: Array<{
    evidence: Array<{ role: string; path: string }>;
  }> = [];
  let hasUnknownEvidence = input.atif.extra?.scope?.trajectory_state !== "complete";

  for (const [stepIndex, step] of input.atif.steps.entries()) {
    for (const [callIndex, call] of (step.tool_calls ?? []).entries()) {
      const evidence = call.extra?.scope;
      const startedAt = evidence?.started_at ? Date.parse(evidence.started_at) : undefined;
      const endedAt = evidence?.ended_at ? Date.parse(evidence.ended_at) : undefined;
      const elapsedMs = startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined;
      const durationMs = evidence?.duration_ms ?? elapsedMs;

      if (
        (elapsedMs !== undefined && elapsedMs < 0) ||
        (elapsedMs !== undefined && evidence?.duration_ms !== undefined && Math.abs(elapsedMs - evidence.duration_ms) > 1)
      ) {
        hasUnknownEvidence = true;
        continue;
      }

      const explicitTimeout = evidence?.outcome === "timeout";
      const exceedsPolicy = durationMs !== undefined &&
        config.threshold_ms !== undefined &&
        durationMs >= config.threshold_ms;
      const interrupted = evidence?.progress_interrupted === true ||
        evidence?.outcome === "abandoned" ||
        evidence?.outcome === "pending";

      if (explicitTimeout || (exceedsPolicy && interrupted)) {
        occurrences.push({
          evidence: [{
            role: "call",
            path: `$.steps[${stepIndex}].tool_calls[${callIndex}]`,
          }],
        });
      } else if (
        durationMs === undefined ||
        !evidence?.outcome ||
        evidence.outcome === "pending" ||
        (config.threshold_ms === undefined && evidence?.progress_interrupted !== false) ||
        (exceedsPolicy && evidence?.progress_interrupted === undefined)
      ) {
        hasUnknownEvidence = true;
      }
    }
  }

  if (occurrences.length) {
    return { state: "completed", observed: true, occurrences };
  }
  if (hasUnknownEvidence) {
    return {
      state: "indeterminate",
      reason: "Complete evidence or reliable call timing/outcome and an applicable delay policy are missing or contradictory.",
    };
  }
  return { state: "completed", observed: false };
}

/** Built-in registry entry referenced by YAML as `scope/timeout-v1`. */
export const timeoutHandler: DeterministicHandler<TimeoutConfig, Assessment> = {
  configSchema: timeoutConfigSchema,
  evaluate: evaluateTimeout,
};
