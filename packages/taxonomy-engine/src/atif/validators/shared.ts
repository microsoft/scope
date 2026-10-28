// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

export const jsonObjectSchema = z.record(z.unknown());
const nonnegativeInteger = z.number().int().nonnegative();

export const agentSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  model_name: z.string().min(1).nullable().optional(),
  tool_definitions: z.array(z.object({
    type: z.literal("function"),
    function: z.record(z.unknown()),
  }).strict()).nullable().optional(),
  extra: z.record(z.unknown()).nullable().optional(),
}).strict();

export const metricsSchema = z.object({
  prompt_tokens: z.number().int().nullable().optional(),
  completion_tokens: z.number().int().nullable().optional(),
  cached_tokens: z.number().int().nullable().optional(),
  cost_usd: z.number().finite().nullable().optional(),
  prompt_token_ids: z.array(z.number().int()).nullable().optional(),
  completion_token_ids: z.array(z.number().int()).nullable().optional(),
  logprobs: z.array(z.number().finite()).nullable().optional(),
  extra: z.record(z.unknown()).nullable().optional(),
}).strict();

export const finalMetricsSchema = z.object({
  total_prompt_tokens: z.number().int().nullable().optional(),
  total_completion_tokens: z.number().int().nullable().optional(),
  total_cached_tokens: z.number().int().nullable().optional(),
  total_cost_usd: z.number().finite().nullable().optional(),
  total_steps: nonnegativeInteger.nullable().optional(),
  extra: z.record(z.unknown()).nullable().optional(),
}).strict();

export const imageSourceSchema = z.object({
  media_type: z.enum([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]),
  path: z.string().min(1),
}).strict();

export const audioAliases: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/mpga": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-aiff": "audio/aiff",
};

export const audioSourceSchema = z.object({
  media_type: z.preprocess(value => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    return audioAliases[normalized] ?? normalized;
  }, z.enum([
    "audio/wav",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/flac",
    "audio/webm",
    "audio/aiff",
  ])),
  path: z.string().min(1),
  duration_sec: z.number().finite().nonnegative().nullable().optional(),
}).strict();

export const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  source: z.null().optional(),
}).strict();

export const imagePartSchema = z.object({
  type: z.literal("image"),
  source: imageSourceSchema,
  text: z.null().optional(),
}).strict();

export const audioPartSchema = z.object({
  type: z.literal("audio"),
  source: audioSourceSchema,
  text: z.null().optional(),
}).strict();

export const toolCallBaseSchema = z.object({
  tool_call_id: z.string().min(1),
  function_name: z.string().min(1),
  arguments: jsonObjectSchema,
});

export function observationSchema(
  contentPart: z.ZodTypeAny,
  resultExtra: boolean,
  subagentRef: z.ZodTypeAny,
) {
  const result = z.object({
    source_call_id: z.string().min(1).nullable().optional(),
    content: z.union([
      z.string(),
      z.array(contentPart),
      z.null(),
    ]).optional(),
    subagent_trajectory_ref: z.array(subagentRef).nullable().optional(),
    ...(resultExtra
      ? { extra: z.record(z.unknown()).nullable().optional() }
      : {}),
  }).strict();
  return z.object({
    results: z.array(result),
  }).strict();
}

export function stepSchema(options: {
  contentPart: z.ZodTypeAny;
  toolCall: z.ZodTypeAny;
  observation: z.ZodTypeAny;
  llmCallCount: boolean;
}) {
  return z.object({
    step_id: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }).nullable().optional(),
    source: z.enum(["system", "user", "agent"]),
    model_name: z.string().min(1).nullable().optional(),
    reasoning_effort: z.union([
      z.string(),
      z.number().finite(),
    ]).nullable().optional(),
    message: z.union([z.string(), z.array(options.contentPart)]),
    reasoning_content: z.string().nullable().optional(),
    tool_calls: z.array(options.toolCall).nullable().optional(),
    observation: options.observation.nullable().optional(),
    metrics: metricsSchema.nullable().optional(),
    is_copied_context: z.boolean().nullable().optional(),
    ...(options.llmCallCount
      ? { llm_call_count: nonnegativeInteger.nullable().optional() }
      : {}),
    extra: z.record(z.unknown()).nullable().optional(),
  }).strict().superRefine((step, context) => {
    if (step.source !== "agent") {
      for (const field of [
        "model_name",
        "reasoning_effort",
        "reasoning_content",
        "tool_calls",
        "metrics",
      ] as const) {
        if (step[field] != null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `Field '${field}' is only applicable to agent steps`,
          });
        }
      }
    }
    if (
      "llm_call_count" in step &&
      step.llm_call_count === 0 &&
      step.source === "agent"
    ) {
      for (const field of ["metrics", "reasoning_content"] as const) {
        if (step[field] != null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `Field '${field}' must be absent when llm_call_count is 0`,
          });
        }
      }
    }
  });
}

export function trajectorySchema(options: {
  version: "ATIF-v1.6" | "ATIF-v1.7" | "ATIF-v1.8";
  step: z.ZodTypeAny;
  sessionRequired: boolean;
  identityFields: boolean;
  embeddedSubagents: z.ZodTypeAny | false;
}) {
  const base = z.object({
    schema_version: z.literal(options.version),
    session_id: options.sessionRequired
      ? z.string().min(1)
      : z.string().min(1).nullable().optional(),
    ...(options.identityFields
      ? { trajectory_id: z.string().min(1).nullable().optional() }
      : {}),
    agent: agentSchema,
    steps: z.array(options.step),
    notes: z.string().nullable().optional(),
    final_metrics: finalMetricsSchema.nullable().optional(),
    continued_trajectory_ref: z.string().min(1).nullable().optional(),
    extra: z.record(z.unknown()).nullable().optional(),
    ...(options.embeddedSubagents
      ? {
        subagent_trajectories: z.array(
          options.embeddedSubagents,
        ).nullable().optional(),
      }
      : {}),
  }).strict();
  return base.superRefine((trajectory, context) => {
    const toolCallIds = new Set<string>();
    trajectory.steps.forEach((step: { step_id: number }, index: number) => {
      if (
        index > 0 &&
        step.step_id <= (
          trajectory.steps[index - 1] as { step_id: number }
        ).step_id
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "step_id"],
          message: "step_id values must be strictly increasing",
        });
      }
      const typedStep = step as {
        tool_calls?: Array<{ tool_call_id: string }> | null;
        observation?: {
          results?: Array<{ source_call_id?: string | null }>;
        } | null;
      };
      for (const [callIndex, call] of (
        typedStep.tool_calls ?? []
      ).entries()) {
        if (toolCallIds.has(call.tool_call_id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "tool_calls", callIndex, "tool_call_id"],
            message: `Duplicate tool_call_id '${call.tool_call_id}'`,
          });
        }
        toolCallIds.add(call.tool_call_id);
      }
    });
    trajectory.steps.forEach((step: unknown, stepIndex: number) => {
      const results = (
        step as {
          observation?: {
            results?: Array<{ source_call_id?: string | null }>;
          } | null;
        }
      ).observation?.results ?? [];
      for (const [resultIndex, result] of results.entries()) {
        if (
          result.source_call_id &&
          !toolCallIds.has(result.source_call_id)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              "steps",
              stepIndex,
              "observation",
              "results",
              resultIndex,
              "source_call_id",
            ],
            message:
              `Observation references unknown tool_call_id '${result.source_call_id}'`,
          });
        }
      }
    });
    if (options.embeddedSubagents) {
      const trajectoryIds = new Set<string>();
      let invalidTrajectoryIds = false;
      const children = (
        trajectory.subagent_trajectories ?? []
      ) as Array<Record<string, unknown>>;
      for (const [index, child] of children.entries()) {
        const trajectoryId = (
          child as { trajectory_id?: string | null }
        ).trajectory_id;
        if (!trajectoryId) {
          invalidTrajectoryIds = true;
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subagent_trajectories", index, "trajectory_id"],
            message: "Embedded subagent trajectory requires trajectory_id",
          });
          continue;
        }
        if (trajectoryIds.has(trajectoryId)) {
          invalidTrajectoryIds = true;
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subagent_trajectories", index, "trajectory_id"],
            message: `Duplicate embedded trajectory_id '${trajectoryId}'`,
          });
        }
        trajectoryIds.add(trajectoryId);
      }
      if (invalidTrajectoryIds) return;
      for (const [stepIndex, step] of trajectory.steps.entries()) {
        const results = (
          step as {
            observation?: {
              results?: Array<{
                subagent_trajectory_ref?: Array<{
                  trajectory_id?: string | null;
                  trajectory_path?: string | null;
                }> | null;
              }>;
            } | null;
          }
        ).observation?.results ?? [];
        for (const [resultIndex, result] of results.entries()) {
          for (const [referenceIndex, reference] of (
            result.subagent_trajectory_ref ?? []
          ).entries()) {
            if (
              reference.trajectory_id &&
              !reference.trajectory_path &&
              !trajectoryIds.has(reference.trajectory_id)
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [
                  "steps",
                  stepIndex,
                  "observation",
                  "results",
                  resultIndex,
                  "subagent_trajectory_ref",
                  referenceIndex,
                  "trajectory_id",
                ],
                message:
                  `Subagent trajectory_id '${reference.trajectory_id}' does not match an embedded trajectory`,
              });
            }
          }
        }
      }
    }
  });
}
