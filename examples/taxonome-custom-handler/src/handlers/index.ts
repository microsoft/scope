// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  defineTaxonomePlugin,
  type DeterministicHandler,
  type HandlerConfigSchema,
} from "taxonomy-engine/plugins";
import type { ScopeSource } from "taxonomy-engine";

interface RetryConfig {
  /** Minimum explicit attempt count that qualifies as a retry. */
  min_attempts: number;
}

const retryConfigSchema: HandlerConfigSchema<RetryConfig> = z.object({
  min_attempts: z.number().int().min(2).default(2),
}).strict();

const retrySourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  surface_id: z.string().min(1),
}).strict();

const retryOriginSchema = z.object({
  iteration: z.number().int().positive(),
  step_id: z.number().int().positive(),
  tool_call_id: z.string().min(1),
}).strict();

const retryOccurrenceSchema = z.object({
  source: retrySourceSchema,
  related_turns: z.array(z.number().int().positive()).min(1),
  tool_call_id: z.string().min(1),
  origin: retryOriginSchema.optional(),
  attempts: z.number().int().min(2),
}).strict();

/**
 * Producer-side output schema. Element YAML remains the runtime contract
 * enforced by Taxonome after the handler returns.
 */
export const retryOutputSchema = z.union([
  z.object({
    state: z.literal("completed"),
    observed: z.literal(true),
    occurrences: z.array(retryOccurrenceSchema).min(1),
  }).strict(),
  z.object({
    state: z.literal("completed"),
    observed: z.literal(false),
  }).strict(),
  z.object({
    state: z.literal("indeterminate"),
    reason: z.string().min(1),
  }).strict(),
  z.object({
    state: z.literal("error"),
    error: z.string().min(1),
  }).strict(),
]);

/** Output produced by the custom handler before YAML-schema validation. */
export type RetryOutput = z.infer<typeof retryOutputSchema>;

/** One positive occurrence produced by the custom handler. */
type RetryOccurrence = z.infer<typeof retryOccurrenceSchema>;

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
export const retryHandler: DeterministicHandler<RetryConfig, RetryOutput> = {
  configSchema: retryConfigSchema,
  evaluate(input, config) {
    // Index declared sources so occurrences copy only grounded source metadata.
    const sources = new Map(
      (input.atif.extra?.scope?.available_sources ?? [])
        .map(source => [source.id, source]),
    );
    const occurrences: RetryOccurrence[] = [];
    let recoveredWithoutSource = false;

    // Accept only explicit structured retry evidence from tool-call responses.
    for (const step of input.atif.steps) {
      for (const call of step.tool_calls ?? []) {
        const response = call.extra?.scope?.response;
        const parsedResponse = retryResponseSchema.safeParse(response);
        if (
          !parsedResponse.success ||
          parsedResponse.data.recovered !== true ||
          parsedResponse.data.attempts < config.min_attempts
        ) {
          continue;
        }

        const sourceId = call.extra?.scope?.source_id;
        const source: ScopeSource | undefined = sourceId
          ? sources.get(sourceId)
          : undefined;
        if (!source) {
          recoveredWithoutSource = true;
          continue;
        }

        const callOrigin = call.extra?.scope?.origin;
        const originalStepId = step.extra?.scope?.origin?.step_id;
        const origin = callOrigin?.iteration &&
          callOrigin.tool_call_id &&
          typeof originalStepId === "number"
          ? {
            iteration: callOrigin.iteration,
            step_id: originalStepId,
            tool_call_id: callOrigin.tool_call_id,
          }
          : undefined;

        occurrences.push({
          source,
          related_turns: [step.step_id],
          tool_call_id: call.tool_call_id,
          ...(origin ? { origin } : {}),
          attempts: parsedResponse.data.attempts,
        });
      }
    }

    // Completed absence is valid because this handler examines every normalized call.
    const output: RetryOutput = occurrences.length
      ? { state: "completed", observed: true, occurrences }
      : recoveredWithoutSource
        ? {
          state: "indeterminate",
          reason: "Recovered retry evidence is missing source attribution.",
        }
        : { state: "completed", observed: false };
    return retryOutputSchema.parse(output);
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
