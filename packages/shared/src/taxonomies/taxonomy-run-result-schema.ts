// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

const evidenceTypeSchema = z.enum([
  "atif.step",
  "atif.tool_call",
  "atif.observation",
  "atif.observation_result",
  "atif.content_part",
  "atif.image_source",
  "atif.audio_source",
  "scope.discovery",
  "scope.input_validation_issue",
]);

const assessmentSchema = z.union([
  z.object({
    state: z.literal("completed"),
    observed: z.literal(true),
    occurrences: z.array(
      z.object({
        evidence: z.array(
          z.object({
            role: z.string().min(1),
            path: z.string().min(1),
          }).strict(),
        ).min(1).max(100),
      }).strict(),
    ).min(1).max(100),
  }).strict(),
  z.object({
    state: z.literal("completed"),
    observed: z.literal(false),
  }).strict(),
  z.object({
    state: z.enum(["indeterminate", "inapplicable"]),
    reason: z.string().min(1).max(2_000),
  }).strict(),
]);

const diagnosticSchema = z.object({
  code: z.enum([
    "invalid_json",
    "schema_mismatch",
    "unknown_role",
    "role_cardinality",
    "duplicate_reference",
    "invalid_jsonpath",
    "unresolved_reference",
    "reference_type_mismatch",
    "reference_constraint_mismatch",
  ]),
  output_path: z.string().min(1),
  role: z.string().min(1).optional(),
  evidence_path: z.string().min(1).optional(),
  expected_type: evidenceTypeSchema.optional(),
  actual_type: evidenceTypeSchema.optional(),
  message: z.string().min(1).max(1_000).optional(),
}).strict();

const evaluationBaseSchema = z.object({
  schema_version: z.literal("scope/taxonomy-evaluation/v1"),
  taxonomy: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  element: z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    category_id: z.string().min(1).optional(),
  }).strict(),
  implementation: z.object({
    type: z.enum(["prompt", "deterministic"]),
    handler: z.string().min(1).optional(),
    provider: z.object({
      name: z.string().min(1),
      version: z.string().min(1).optional(),
      origin: z.enum(["builtin", "local", "package"]),
      entry: z.string().min(1).optional(),
      integrity: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }).strict().optional(),
    attempts: z.array(z.object({
      attempt: z.union([z.literal(1), z.literal(2)]),
      kind: z.enum(["initial", "repair"]),
      outcome: z.enum([
        "succeeded",
        "invalid_output",
        "execution_failed",
        "cancelled",
      ]),
    }).strict()).min(1).max(2),
  }).strict(),
  input: z.object({
    normalization: z.literal("scope/taxonome-normalized-atif/v1"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    trajectory_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    request_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    archive_root: z.string().min(1).optional(),
  }).strict(),
});

/** Portable exact-run Taxonome result envelope returned by the API. */
export const TaxonomyRunResultResponseSchema = z.object({
  run: z.object({
    id: z.string().min(1),
    scenario: z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      task: z.string().optional(),
    }).strict(),
    profile: z.object({
      id: z.string().min(1),
      label: z.string().min(1),
    }).strict(),
  }).strict(),
  results: z.array(z.discriminatedUnion("status", [
    evaluationBaseSchema.extend({
      status: z.literal("succeeded"),
      result: assessmentSchema,
    }).strict(),
    evaluationBaseSchema.extend({
      status: z.literal("failed"),
      error: z.object({
        code: z.enum([
          "execution_failed",
          "cancelled",
          "invalid_output",
          "invalid_input_binding",
        ]),
        message: z.string().min(1).max(2_000),
        validation_errors: z.array(diagnosticSchema).max(100).optional(),
        source_locations: z.array(z.object({
          normalized_path: z.string().min(1),
          original_path: z.string().min(1),
          file: z.string().optional(),
          archive_entry: z.string().optional(),
          jsonl_line: z.number().int().positive().optional(),
          generated_by: z.string().optional(),
        }).strict()).max(100).optional(),
      }).strict(),
    }).strict(),
  ])),
  metadata: z.unknown().optional(),
}).strict().openapi("TaxonomyRunResultResponse");

export type TaxonomyRunResultResponse = z.infer<
  typeof TaxonomyRunResultResponseSchema
>;
