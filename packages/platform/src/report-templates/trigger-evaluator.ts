// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  ReportTrigger,
  RequestDocument,
  TaskPromptDocument,
  PromptFeatureResult,
} from '@scope/core';

/**
 * Evaluate whether a report template's trigger matches a completed run.
 *
 * @param trigger - The trigger definition from a ReportTemplateDocument.
 *                  If undefined/null, defaults to "always" (matches every run).
 * @param run     - The completed RequestDocument.
 * @param taskPrompt - The TaskPromptDocument for the run's task (needed for promptFeature triggers).
 *                     May be undefined if the run has no materialized taskPromptId.
 * @returns true if the report should be generated for this run.
 */
export function evaluateTrigger(
  trigger: ReportTrigger | undefined | null,
  run: RequestDocument,
  taskPrompt?: TaskPromptDocument | null
): boolean {
  // No trigger = always fire
  if (!trigger) return true;

  switch (trigger.type) {
    case 'always':
      return true;

    case 'criteria':
      return evaluateCriteriaTrigger(trigger.criteriaIds, trigger.match, run);

    case 'taskPrompt':
      return evaluateTaskPromptTrigger(trigger.taskPromptIds, run);

    case 'promptFeature':
      return evaluatePromptFeatureTrigger(trigger.featureIds, trigger.match, taskPrompt);

    default:
      // Unknown trigger type — fail closed (don't generate)
      return false;
  }
}

/**
 * Match against the run's scenario criteria IDs.
 */
function evaluateCriteriaTrigger(
  criteriaIds: string[],
  match: 'any' | 'all' | undefined,
  run: RequestDocument
): boolean {
  const runCriteria = run.scenario?.criteria ?? [];
  if (criteriaIds.length === 0) return false;

  if (match === 'all') {
    return criteriaIds.every((id) => runCriteria.includes(id));
  }
  // Default: "any"
  return criteriaIds.some((id) => runCriteria.includes(id));
}

/**
 * Exact match against the run's taskPromptId (content-addressed UUIDv5).
 */
function evaluateTaskPromptTrigger(
  taskPromptIds: string[],
  run: RequestDocument
): boolean {
  if (!run.taskPromptId) return false;
  return taskPromptIds.includes(run.taskPromptId);
}

/**
 * Match against detected prompt features in the run's TaskPromptDocument.
 */
function evaluatePromptFeatureTrigger(
  featureIds: string[],
  match: 'any' | 'all' | undefined,
  taskPrompt?: TaskPromptDocument | null
): boolean {
  if (!taskPrompt?.features || taskPrompt.features.length === 0) return false;
  if (featureIds.length === 0) return false;

  // Only consider features that were detected
  const detectedIds = new Set(
    taskPrompt.features
      .filter((f: PromptFeatureResult) => f.detected)
      .map((f: PromptFeatureResult) => f.featureId)
  );

  if (match === 'all') {
    return featureIds.every((id) => detectedIds.has(id));
  }
  // Default: "any"
  return featureIds.some((id) => detectedIds.has(id));
}
