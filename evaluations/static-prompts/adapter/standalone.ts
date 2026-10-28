// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  evaluate,
  parseScopeAtif,
  validateScopeAtif,
} from "taxonomy-engine";
import { loadAgentBehaviorTaxonomy } from "ax-taxonomy";
import {
  copilotAI,
  taxonomyPromptExecutor,
  type CopilotTransport,
} from "taxonomy-engine/copilot";

const productionTaxonomy = loadAgentBehaviorTaxonomy();

/** Creates one standalone family over an authored catalog prompt element. */
function createStandaloneTarget(
  family: string,
  elementId: string,
  inputs: string,
  groundTruth: string,
) {
  return {
    family,
    variant: "default",
    transport: "copilot-sdk",
    inputs,
    groundTruth,
    /**
     * Runs one input through the production Ax/SDK adapter and shared grounding validator.
     *
     * @param input - Untrusted evaluation input.
     * @param transport - Explicit Copilot SDK transport supplied by the standalone runner.
     * @param model - Exact model ID used by the adapter.
     */
    async run(input: unknown, transport: CopilotTransport, model: string) {
      const taxonomy = await productionTaxonomy;
      const atif = parseScopeAtif(input);
      validateScopeAtif(atif, taxonomy);
      const [evaluation] = await evaluate(
        { atif, taxonomy },
        [elementId],
        taxonomyPromptExecutor(copilotAI(transport, model)),
      );
      if (evaluation.status === "failed") {
        throw new Error(
          `${evaluation.error.code}: ${evaluation.error.message}; ` +
          `${evaluation.error.validation_errors?.map(item => item.code).join(", ") ?? ""}`,
        );
      }
      return evaluation.result;
    },
  } as const;
}

/** JSONL target registry for standalone SDK-only families (not the Azure runner). */
export const standaloneTargets = {
  "taxonome-skipped-invocation/default": createStandaloneTarget(
    "taxonome-skipped-invocation",
    "beh-skipped-invocation",
    "packages/ax-taxonomy/fixtures/skipped-invocation-inputs.jsonl",
    "packages/ax-taxonomy/fixtures/skipped-invocation-ground-truth.json",
  ),
  "taxonome-wrong-discovery/default": createStandaloneTarget(
    "taxonome-wrong-discovery",
    "beh-wrong-discovery",
    "packages/ax-taxonomy/fixtures/wrong-discovery-inputs.jsonl",
    "packages/ax-taxonomy/fixtures/wrong-discovery-ground-truth.json",
  ),
  "taxonome-content-misused/default": createStandaloneTarget(
    "taxonome-content-misused",
    "beh-content-misused",
    "packages/ax-taxonomy/fixtures/content-misused-inputs.jsonl",
    "packages/ax-taxonomy/fixtures/content-misused-ground-truth.json",
  ),
} as const;

/**
 * Exposes a JSON-safe inventory that the evaluation manifest coverage check can compare exactly.
 *
 * @returns One descriptor per standalone family/variant pair.
 */
export function listStandaloneTargets() {
  return Object.entries(standaloneTargets).map(([adapterId, target]) => ({
    adapterId,
    family: target.family,
    variant: target.variant,
    transport: target.transport,
  }));
}
