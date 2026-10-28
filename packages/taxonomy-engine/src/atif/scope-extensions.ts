// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { canonicalJsonStringify } from "../canonical-json.js";
import { originalAtifPath } from "./source-map.js";
import type {
  AtifV18Canonical,
  AtifIngestionResult,
  AtifProvenance,
  AtifSourceMapping,
} from "./types.js";
import { AtifIngestionError } from "./types.js";

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

const inputValidationIssueSchema = z.object({
  code: z.string().min(1),
  path: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
}).strict();

const inputValidationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid") }).strict(),
  z.object({
    status: z.literal("invalid"),
    issues: z.array(inputValidationIssueSchema).min(1),
  }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);

const toolCallScopeSchema = z.object({
  origin: originSchema.optional(),
  source_id: z.string().min(1).optional(),
  outcome: z.enum([
    "timeout",
    "completed",
    "error",
    "abandoned",
    "pending",
  ]).optional(),
  duration_ms: z.number().finite().nonnegative().optional(),
  started_at: z.string().datetime({ offset: true }).optional(),
  ended_at: z.string().datetime({ offset: true }).optional(),
  progress_interrupted: z.boolean().optional(),
  input_validation: inputValidationSchema.optional(),
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

const rootScopeSchema = z.object({
  schema_version: z.literal(SCOPE_ATIF_EXTENSION_VERSION),
  trajectory_state: z.enum([
    "complete",
    "partial",
    "unknown",
  ]).default("complete"),
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

export type ScopeSource = z.infer<typeof sourceSchema>;
export type ScopeInputValidationIssue = z.infer<
  typeof inputValidationIssueSchema
>;
export type ScopeDiscovery = z.infer<typeof discoverySchema>;

function issueSuffix(path: readonly (string | number)[]): string {
  return path.map(segment =>
    typeof segment === "number"
      ? `[${segment}]`
      : /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)
        ? `.${segment}`
        : `[${JSON.stringify(segment)}]`
  ).join("");
}

function parseScopeNamespace<Output>(
  schema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  value: unknown,
  normalizedRoot: string,
  provenance: AtifProvenance,
): Output {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const normalizedPath = `${normalizedRoot}${issueSuffix(issue.path)}`;
  const original = originalAtifPath(provenance, normalizedPath);
  throw new AtifIngestionError({
    code: "atif_invalid_scope_extension",
    stage: "scope_normalization",
    message: issue.message,
    ...(original.source ?? provenance.source),
    original_path: original.path,
    normalized_path: normalizedPath,
    source_version: provenance.source_version,
    target_version: "ATIF-v1.8",
    ...(original.generated_by
      ? { generated_by: original.generated_by }
      : {}),
  });
}

type ScopeExtra = Record<string, unknown> & {
  scope?: z.infer<typeof rootScopeSchema>;
};
type ScopeStepExtra = Record<string, unknown> & {
  scope?: z.infer<typeof stepScopeSchema>;
};
type ScopeCallExtra = Record<string, unknown> & {
  scope?: z.infer<typeof toolCallScopeSchema>;
};

export type ScopeAtif = Omit<AtifV18Canonical, "steps" | "extra"> & {
  steps: Array<
    Omit<AtifV18Canonical["steps"][number], "extra" | "tool_calls"> & {
    extra?: ScopeStepExtra | null;
    tool_calls?: Array<
      Omit<
        NonNullable<
          AtifV18Canonical["steps"][number]["tool_calls"]
        >[number],
        "extra"
      > & { extra?: ScopeCallExtra | null }
    > | null;
  }
  >;
  extra?: ScopeExtra | null;
};

function normalizeScopeExtensionsInternal(
  input: AtifV18Canonical,
  provenance: AtifProvenance,
  copyInput: boolean,
): AtifIngestionResult<ScopeAtif> {
  const value = (
    copyInput ? structuredClone(input) : input
  ) as ScopeAtif;
  let nextProvenance = provenance;
  let mutableMappings: AtifSourceMapping[] | undefined;
  const appendMapping = (mapping: AtifSourceMapping) => {
    if (!mutableMappings) {
      mutableMappings = [...nextProvenance.mappings];
      nextProvenance = {
        ...nextProvenance,
        mappings: mutableMappings,
      };
    }
    mutableMappings.push(mapping);
  };
  const rootExtra = value.extra ?? {};
  if ("scope" in rootExtra && rootExtra.scope !== undefined) {
    rootExtra.scope = parseScopeNamespace(
      rootScopeSchema,
      rootExtra.scope,
      "$.extra.scope",
      provenance,
    );
  } else {
    rootExtra.scope = rootScopeSchema.parse({
      schema_version: SCOPE_ATIF_EXTENSION_VERSION,
      trajectory_state: "complete",
      available_sources: [],
    });
    appendMapping({
      normalized_prefix: "$.extra.scope",
      original_prefix: provenance.container_prefix,
      generated_by: "scope-defaults",
      mode: "anchor",
    });
  }
  value.extra = rootExtra;

  for (const [stepIndex, step] of value.steps.entries()) {
    if (step.extra?.scope !== undefined) {
      step.extra.scope = parseScopeNamespace(
        stepScopeSchema,
        step.extra.scope,
        `$.steps[${stepIndex}].extra.scope`,
        provenance,
      );
    }
    const existingResults = step.observation?.results ?? [];
    for (const [callIndex, call] of (
      step.tool_calls ?? []
    ).entries()) {
      if (call.extra?.scope !== undefined) {
        call.extra.scope = parseScopeNamespace(
          toolCallScopeSchema,
          call.extra.scope,
          `$.steps[${stepIndex}].tool_calls[${callIndex}].extra.scope`,
          provenance,
        );
      }
      const response = call.extra?.scope?.response;
      if (
        response === undefined ||
        existingResults.some((result: {
          source_call_id?: string | null;
        }) =>
          result.source_call_id === call.tool_call_id
        )
      ) continue;
      const content = typeof response === "string" ||
          Array.isArray(response)
        ? response
        : canonicalJsonStringify(response);
      if (!step.observation) step.observation = { results: [] };
      const resultIndex = step.observation.results.length;
      const responsePath =
        `$.steps[${stepIndex}].tool_calls[${callIndex}].extra.scope.response`;
      const responseOriginal = originalAtifPath(
        nextProvenance,
        responsePath,
      );
      step.observation.results.push({
        source_call_id: call.tool_call_id,
        content,
      });
      appendMapping({
        normalized_prefix:
          `$.steps[${stepIndex}].observation.results[${resultIndex}].content`,
        original_prefix: responseOriginal.path,
        ...(responseOriginal.source
          ? { source: responseOriginal.source }
          : {}),
        generated_by: "scope-response-normalization",
      });
    }
  }

  return { atif: value, provenance: nextProvenance };
}

/** Validates Scope namespaces without mutating the caller's document. */
export function normalizeScopeExtensions(
  input: AtifV18Canonical,
  provenance: AtifProvenance,
): AtifIngestionResult<ScopeAtif> {
  return normalizeScopeExtensionsInternal(input, provenance, true);
}

/** Normalizes a validation-owned document in place to avoid another tree copy. */
export function normalizeOwnedScopeExtensions(
  input: AtifV18Canonical,
  provenance: AtifProvenance,
): AtifIngestionResult<ScopeAtif> {
  return normalizeScopeExtensionsInternal(input, provenance, false);
}
