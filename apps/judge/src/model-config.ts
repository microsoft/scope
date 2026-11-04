// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Provider-resolved model selection used when no explicit Judge model is set. */
export const DEFAULT_JUDGE_MODEL = "auto";

/** Resolves the Judge model with constructor input taking precedence over env. */
export function resolveJudgeModel(
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return model || env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
}

/** Resolves the feedback model independently while keeping the same safe default. */
export function resolveFeedbackModel(
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return model || env.FEEDBACK_MODEL || DEFAULT_JUDGE_MODEL;
}
