// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  defineTaxonomePlugin,
  type DeterministicHandler,
  type HandlerConfigSchema,
} from "taxonomy-engine/plugins";
import type { Assessment } from "taxonomy-engine";

interface RetryConfig {
  /** Minimum explicit attempt count that qualifies as a retry. */
  min_attempts: number;
}

const retryConfigSchema: HandlerConfigSchema<RetryConfig> = z.object({
  min_attempts: z.number().int().min(2).default(2),
}).strict();

const retryResponseSchema = z.object({
  attempts: z.number().int(),
  recovered: z.boolean(),
}).passthrough();

/**
 * Detects a recovered retry sequence from explicit Scope call-response evidence.
 *
 * @param input - Frozen normalized ATIF plus loaded taxonomy.
 * @param config - YAML policy; `min_attempts` is the minimum observed attempts.
 */
export const retryHandler: DeterministicHandler<RetryConfig, Assessment> = {
  configSchema: retryConfigSchema,
  evaluate(input, config) {
    const occurrences: Array<{
      evidence: Array<{ role: string; path: string }>;
    }> = [];

    // Accept only explicit structured retry evidence from tool-call responses.
    for (const [stepIndex, step] of input.atif.steps.entries()) {
      for (const [callIndex, call] of (step.tool_calls ?? []).entries()) {
        const response = call.extra?.scope?.response;
        const parsedResponse = retryResponseSchema.safeParse(response);
        if (
          !parsedResponse.success ||
          parsedResponse.data.recovered !== true ||
          parsedResponse.data.attempts < config.min_attempts
        ) {
          continue;
        }

        occurrences.push({
          evidence: [{
            role: "call",
            path: `$.steps[${stepIndex}].tool_calls[${callIndex}]`,
          }],
        });
      }
    }

    // Completed absence is valid because this handler examines every normalized call.
    const output: Assessment = occurrences.length
      ? { state: "completed", observed: true, occurrences }
      : { state: "completed", observed: false };
    return output;
  },
};

export const taxonomePlugin = defineTaxonomePlugin({
  api_version: "scope/taxonome-plugin/v1",
  provider: {
    name: "taxonome-custom-handler-example",
    version: "1.0.0",
  },
  handlers: {
    "acme/retry-loop-v1": retryHandler,
  },
});
