// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  audioPartSchema,
  imagePartSchema,
  observationSchema,
  stepSchema,
  textPartSchema,
  toolCallBaseSchema,
  trajectorySchema,
} from "./shared.js";

const contentPartV16V17 = z.discriminatedUnion("type", [
  textPartSchema,
  imagePartSchema,
]);

export const contentPartV18Schema = z.discriminatedUnion("type", [
  textPartSchema,
  imagePartSchema,
  audioPartSchema,
]);

const legacySubagentRef = z.object({
  session_id: z.string().min(1),
  trajectory_path: z.string().min(1).nullable().optional(),
  extra: z.record(z.unknown()).nullable().optional(),
}).strict();

const modernSubagentRef = z.object({
  trajectory_id: z.string().min(1).nullable().optional(),
  session_id: z.string().min(1).nullable().optional(),
  trajectory_path: z.string().min(1).nullable().optional(),
  extra: z.record(z.unknown()).nullable().optional(),
}).strict().superRefine((reference, context) => {
  if (!reference.trajectory_id && !reference.trajectory_path) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Subagent reference requires trajectory_id or trajectory_path",
    });
  }
});

const toolCallV16 = toolCallBaseSchema.strict();
const toolCallV17V18 = toolCallBaseSchema.extend({
  extra: z.record(z.unknown()).nullable().optional(),
}).strict();

const stepV16 = stepSchema({
  contentPart: contentPartV16V17,
  toolCall: toolCallV16,
  observation: observationSchema(
    contentPartV16V17,
    false,
    legacySubagentRef,
  ),
  llmCallCount: false,
});
const stepV17 = stepSchema({
  contentPart: contentPartV16V17,
  toolCall: toolCallV17V18,
  observation: observationSchema(
    contentPartV16V17,
    true,
    modernSubagentRef,
  ),
  llmCallCount: true,
});
const stepV18 = stepSchema({
  contentPart: contentPartV18Schema,
  toolCall: toolCallV17V18,
  observation: observationSchema(
    contentPartV18Schema,
    true,
    modernSubagentRef,
  ),
  llmCallCount: true,
});

const supportedEmbeddedTrajectory: z.ZodTypeAny = z.lazy(() =>
  z.union([atifV16Schema, atifV17Schema, atifV18Schema])
);
const canonicalEmbeddedTrajectory: z.ZodTypeAny = z.lazy(() =>
  canonicalAtifV18Schema
);

export const atifV16Schema = trajectorySchema({
  version: "ATIF-v1.6",
  step: stepV16,
  sessionRequired: true,
  identityFields: false,
  embeddedSubagents: false,
});

export const atifV17Schema = trajectorySchema({
  version: "ATIF-v1.7",
  step: stepV17,
  sessionRequired: false,
  identityFields: true,
  embeddedSubagents: supportedEmbeddedTrajectory,
});

export const atifV18Schema = trajectorySchema({
  version: "ATIF-v1.8",
  step: stepV18,
  sessionRequired: false,
  identityFields: true,
  embeddedSubagents: supportedEmbeddedTrajectory,
});

export const canonicalAtifV18Schema = trajectorySchema({
  version: "ATIF-v1.8",
  step: stepV18,
  sessionRequired: false,
  identityFields: true,
  embeddedSubagents: canonicalEmbeddedTrajectory,
});
