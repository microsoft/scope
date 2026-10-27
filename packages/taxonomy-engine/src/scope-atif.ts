// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import type { NormalizedTaxonomy } from "./taxonomy.js";

export const SCOPE_ATIF_EXTENSION_VERSION = "scope.atif-extension.v1";

const sourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  surface_id: z.string().min(1),
}).strict();

const originSchema = z.object({
  iteration: z.number().int().positive().optional(),
  step_id: z.union([z.string(), z.number()]).optional(),
  tool_call_id: z.string().min(1).optional(),
}).strict();

const toolCallScopeSchema = z.object({
  origin: originSchema.optional(),
  source_id: z.string().min(1).optional(),
  outcome: z.enum(["timeout", "completed", "error", "abandoned", "pending"]).optional(),
  duration_ms: z.number().finite().nonnegative().optional(),
  started_at: z.string().datetime({ offset: true }).optional(),
  ended_at: z.string().datetime({ offset: true }).optional(),
  progress_interrupted: z.boolean().optional(),
  response: z.unknown().optional(),
}).strict();

const discoverySchema = z.object({
  source_id: z.string().min(1),
  extension_point: z.string().min(1),
}).strict();

const stepScopeSchema = z.object({
  origin: originSchema.optional(),
  discoveries: z.array(discoverySchema).optional(),
}).strict();

const topLevelScopeSchema = z.object({
  schema_version: z.literal(SCOPE_ATIF_EXTENSION_VERSION),
  trajectory_state: z.enum(["complete", "partial", "unknown"]).default("complete"),
  task: z.string().min(1).optional(),
  run: z.object({
    id: z.string().min(1).optional(),
    request_id: z.string().min(1).optional(),
    scenario_id: z.string().min(1).optional(),
    scenario_label: z.string().min(1).optional(),
    profile_id: z.string().min(1).optional(),
    profile_label: z.string().min(1).optional(),
  }).strict().optional(),
  available_sources: z.array(sourceSchema).default([]),
  configured_capabilities: z.object({
    skills: z.array(z.string()).optional(),
    mcp_servers: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    resources: z.array(z.string()).optional(),
  }).strict().optional(),
  actual_outcomes: z.object({
    mcp_registered: z.boolean().optional(),
    resources: z.array(z.unknown()).optional(),
  }).strict().optional(),
}).strict();

const toolCallSchema = z.object({
  tool_call_id: z.string().min(1),
  function_name: z.string().min(1),
  arguments: z.unknown(),
  extra: z.object({
    scope: toolCallScopeSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

const observationResultSchema = z.object({
  source_call_id: z.string().min(1).optional(),
  content: z.unknown(),
}).passthrough();

const atifStepSchema = z.object({
  step_id: z.number().int().positive(),
  source: z.enum(["system", "user", "agent"]),
  message: z.string(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  observation: z.object({
    results: z.array(observationResultSchema),
  }).passthrough().optional(),
  extra: z.object({
    scope: stepScopeSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

export const scopeAtifSchema = z.object({
  schema_version: z.literal("ATIF-v1.7"),
  session_id: z.string().min(1),
  agent: z.object({ name: z.string().min(1) }).passthrough(),
  steps: z.array(atifStepSchema),
  extra: z.object({
    scope: topLevelScopeSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

export type ScopeSource = z.infer<typeof sourceSchema>;
export type ScopeAtif = z.infer<typeof scopeAtifSchema>;
export type ScopeAtifStep = ScopeAtif["steps"][number];
export type ScopeToolCall = NonNullable<ScopeAtifStep["tool_calls"]>[number];

/** Runtime input shared by prompt and deterministic element execution. */
export interface TaxonomyInput {
  /** Frozen normalized ATIF v1.7 evidence stream. */
  atif: ScopeAtif;
  /** Frozen loaded taxonomy and resolved private implementations. */
  taxonomy: NormalizedTaxonomy;
}

/** Adds the default complete Scope extension to plain ATIF input when absent. */
export function parseScopeAtif(value: unknown): ScopeAtif {
  const candidate = structuredClone(value) as Record<string, unknown>;
  const extra = candidate.extra && typeof candidate.extra === "object" && !Array.isArray(candidate.extra)
    ? candidate.extra as Record<string, unknown>
    : {};
  if (!extra.scope) {
    extra.scope = {
      schema_version: SCOPE_ATIF_EXTENSION_VERSION,
      trajectory_state: "complete",
      available_sources: [],
    };
  }
  candidate.extra = extra;
  return scopeAtifSchema.parse(candidate);
}

/**
 * Validates ordering, identities, surfaces, discovery grounding, and call links.
 *
 * @param atif - Parsed normalized ATIF stream.
 * @param taxonomy - Loaded taxonomy whose surfaces constrain source inventory.
 */
export function validateScopeAtif(atif: ScopeAtif, taxonomy: NormalizedTaxonomy): void {
  const stepIds = atif.steps.map(step => step.step_id);
  if (new Set(stepIds).size !== stepIds.length || stepIds.some((id, index) => index > 0 && id <= stepIds[index - 1])) {
    throw new Error("ATIF step IDs must be unique and strictly increasing");
  }

  const sources = atif.extra?.scope?.available_sources ?? [];
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      throw new Error(`Duplicate Scope source ID '${source.id}'`);
    }
    if (!taxonomy.surfaceById.has(source.surface_id)) {
      throw new Error(`Scope source '${source.id}' references unknown surface '${source.surface_id}'`);
    }
    sourceIds.add(source.id);
  }

  const calls = atif.steps.flatMap(step => step.tool_calls ?? []);
  const callIds = new Set<string>();
  for (const call of calls) {
    if (callIds.has(call.tool_call_id)) {
      throw new Error(`Duplicate ATIF tool call ID '${call.tool_call_id}'`);
    }
    callIds.add(call.tool_call_id);
    const sourceId = call.extra?.scope?.source_id;
    if (sourceId && !sourceIds.has(sourceId)) {
      throw new Error(`Tool call '${call.tool_call_id}' references undeclared source '${sourceId}'`);
    }
  }

  for (const step of atif.steps) {
    for (const discovery of step.extra?.scope?.discoveries ?? []) {
      if (!sourceIds.has(discovery.source_id)) {
        throw new Error(`Discovery at step ${step.step_id} references undeclared source '${discovery.source_id}'`);
      }
    }
    for (const result of step.observation?.results ?? []) {
      if (result.source_call_id && !callIds.has(result.source_call_id)) {
        throw new Error(`Observation references unknown tool call '${result.source_call_id}'`);
      }
    }
  }
}

/** Recursively freezes evidence before any trusted implementation receives it. */
export function freezeTaxonomyInput<Input>(input: Input): Input {
  const visited = new Set<object>();

  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }

  freeze(input);
  return input;
}
