// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  Assessment,
  DeterministicHandler,
  TaxonomyInput as LoadedTaxonomyInput,
} from "taxonomy-engine";
import { z } from "zod";

export const discoveredConfigSchema = z.object({}).strict();
export type DiscoveredConfig = z.infer<typeof discoveredConfigSchema>;

/**
 * Emits one occurrence per unique source, extension point, and discovery turn.
 *
 * @param input - Frozen Scope ATIF with validated source references.
 */
function evaluateDiscovered(
  input: LoadedTaxonomyInput,
): Assessment {
  const occurrences: Array<{
    evidence: Array<{ role: string; path: string }>;
  }> = [];
  const seen = new Set<string>();

  for (const [stepIndex, step] of input.atif.steps.entries()) {
    for (const [discoveryIndex, discovery] of (
      step.extra?.scope?.discoveries ?? []
    ).entries()) {
      const identity = JSON.stringify([
        discovery.source_id,
        discovery.extension_point,
        step.step_id,
      ]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      occurrences.push({
        evidence: [{
          role: "discovery",
          path: `$.steps[${stepIndex}].extra.scope.discoveries[${discoveryIndex}]`,
        }],
      });
    }
  }

  if (occurrences.length) {
    return { state: "completed", observed: true, occurrences };
  }
  if (input.atif.extra?.scope?.trajectory_state !== "complete") {
    return {
      state: "indeterminate",
      reason: "The partial or unknown trajectory may omit discovery events.",
    };
  }
  return { state: "completed", observed: false };
}

/** Built-in registry entry referenced by YAML as `scope/discovered-v1`. */
export const discoveredHandler: DeterministicHandler<
  DiscoveredConfig,
  Assessment
> = {
  configSchema: discoveredConfigSchema,
  evaluate: evaluateDiscovered,
};
