// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

export const NORMALIZED_ATIF_VERSION = "scope/taxonome-normalized-atif/v1";
export const MAX_ASSESSMENT_OCCURRENCES = 100;
export const MAX_EVIDENCE_PER_OCCURRENCE = 100;
export const MAX_ASSESSMENT_REFERENCES = 1_000;

export const evidenceTypeSchema = z.enum([
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
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

export const evidenceReferenceSchema = z.object({
  role: z.string().min(1),
  path: z.string().min(1),
}).strict();
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const assessmentSchema = z.union([
  z.object({
    state: z.literal("completed"),
    observed: z.literal(true),
    occurrences: z.array(z.object({
      evidence: z.array(evidenceReferenceSchema)
        .min(1)
        .max(MAX_EVIDENCE_PER_OCCURRENCE),
    }).strict()).min(1).max(MAX_ASSESSMENT_OCCURRENCES),
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
export type Assessment = z.infer<typeof assessmentSchema>;

export const evidenceRoleSchema = z.object({
  type: evidenceTypeSchema,
  description: z.string().min(1),
  min: z.number().int().nonnegative().default(1),
  max: z.number().int().nonnegative().optional(),
}).strict().superRefine((role, context) => {
  if (role.max !== undefined && role.max < role.min) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "max must be greater than or equal to min",
      path: ["max"],
    });
  }
});
export type EvidenceRole = z.infer<typeof evidenceRoleSchema>;

export const evidenceConstraintSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("owned_by"),
    role: z.string().min(1),
    owner_role: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("after"),
    role: z.string().min(1),
    reference_role: z.string().min(1),
    within: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("descendant_of"),
    role: z.string().min(1),
    reference_role: z.string().min(1),
  }).strict(),
]);
export type EvidenceConstraint = z.infer<typeof evidenceConstraintSchema>;

export interface EvidenceContract {
  evidence_roles: Readonly<Record<string, EvidenceRole>>;
  constraints: readonly EvidenceConstraint[];
}

export const validationDiagnosticSchema = z.object({
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
export type ValidationDiagnostic = z.infer<typeof validationDiagnosticSchema>;

export const inputIdentitySchema = z.object({
  normalization: z.literal(NORMALIZED_ATIF_VERSION),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  trajectory_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  request_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  archive_root: z.string().min(1).optional(),
}).strict();
export type InputIdentity = z.infer<typeof inputIdentitySchema>;

export const attemptProvenanceSchema = z.object({
  attempt: z.union([z.literal(1), z.literal(2)]),
  kind: z.enum(["initial", "repair"]),
  outcome: z.enum([
    "succeeded",
    "invalid_output",
    "execution_failed",
    "cancelled",
  ]),
}).strict();
export type AttemptProvenance = z.infer<typeof attemptProvenanceSchema>;

export const evaluationErrorSchema = z.object({
  code: z.enum([
    "execution_failed",
    "cancelled",
    "invalid_output",
    "invalid_input_binding",
  ]),
  message: z.string().min(1).max(2_000),
  validation_errors: z.array(validationDiagnosticSchema).max(100).optional(),
  source_locations: z.array(z.object({
    normalized_path: z.string().min(1),
    original_path: z.string().min(1),
    file: z.string().optional(),
    archive_entry: z.string().optional(),
    jsonl_line: z.number().int().positive().optional(),
    generated_by: z.string().optional(),
  }).strict()).max(100).optional(),
}).strict();
export type EvaluationError = z.infer<typeof evaluationErrorSchema>;

/** JSON-compatible shared schema supplied to prompt producers. */
export const ASSESSMENT_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["state", "observed", "occurrences"],
      properties: {
        state: { const: "completed" },
        observed: { const: true },
        occurrences: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ASSESSMENT_OCCURRENCES,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["evidence"],
            properties: {
              evidence: {
                type: "array",
                minItems: 1,
                maxItems: MAX_EVIDENCE_PER_OCCURRENCE,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["role", "path"],
                  properties: {
                    role: { type: "string", minLength: 1 },
                    path: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["state", "observed"],
      properties: {
        state: { const: "completed" },
        observed: { const: false },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["state", "reason"],
      properties: {
        state: { enum: ["indeterminate", "inapplicable"] },
        reason: { type: "string", minLength: 1, maxLength: 2_000 },
      },
    },
  ],
} as const;

export const PRODUCTION_REPAIR_POLICY = {
  prompt_initial_attempts: 1,
  prompt_repair_attempts: 1,
  prompt_correction_owner: "ax",
  optimizer_repair_attempts: 0,
  deterministic_attempts: 1,
} as const;
