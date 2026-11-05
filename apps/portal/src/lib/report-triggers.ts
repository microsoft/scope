// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Portal-side mirror of the shared report-template trigger evaluation
 * (`packages/shared/src/report-templates/trigger-evaluator.ts`).
 *
 * Used by the run detail Reports tab to show which report templates would be
 * generated for a run, and to disable the "Generate Report" action when no
 * template matches the run.
 */

import type { ReportTemplate, ReportTrigger, Run, TaskPrompt } from "@/types";

/** Evaluate a single template trigger against a run + its task prompt. */
export function evaluateTrigger(
  trigger: ReportTrigger | undefined | null,
  run: Run | undefined,
  taskPrompt?: TaskPrompt | null,
): boolean {
  if (!run) return false;
  // No trigger = always fire
  if (!trigger) return true;

  switch (trigger.type) {
    case "always":
      return true;

    case "criteria": {
      const runCriteria = run.scenario?.criteria ?? [];
      if (trigger.criteriaIds.length === 0) return false;
      if (trigger.match === "all") {
        return trigger.criteriaIds.every((id) => runCriteria.includes(id));
      }
      return trigger.criteriaIds.some((id) => runCriteria.includes(id));
    }

    case "taskPrompt": {
      if (!run.taskPromptId) return false;
      return trigger.taskPromptIds.includes(run.taskPromptId);
    }

    case "promptFeature": {
      const features = taskPrompt?.features ?? [];
      if (features.length === 0) return false;
      if (trigger.featureIds.length === 0) return false;
      const detected = new Set(features.filter((f) => f.detected).map((f) => f.featureId));
      if (trigger.match === "all") {
        return trigger.featureIds.every((id) => detected.has(id));
      }
      return trigger.featureIds.some((id) => detected.has(id));
    }

    default:
      // Unknown trigger type — fail closed (don't generate)
      return false;
  }
}

/** Return the subset of templates whose trigger matches the given run. */
export function matchingReportTemplates(
  templates: ReportTemplate[] | undefined,
  run: Run | undefined,
  taskPrompt?: TaskPrompt | null,
): ReportTemplate[] {
  if (!templates) return [];
  return templates.filter((t) => evaluateTrigger(t.trigger, run, taskPrompt));
}
