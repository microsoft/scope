// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  QUALITY_FAMILIES,
  type PromptTargetAdapter,
  type QualityFamily,
} from "./protocol.js";
import {
  childDependencySuggestionAdapter,
  criteriaAuthoringAdapter,
  parentDependencySuggestionAdapter,
} from "./targets/criteria.js";
import { feedbackAdapter } from "./targets/feedback.js";
import { contributionTriageAdapter } from "./targets/contribution-triage.js";
import { judgeAdapter } from "./targets/judge.js";
import {
  promptFeatureAuthoringAdapter,
  promptFeatureExtractionAdapter,
} from "./targets/prompt-features.js";
import { reportAdapter } from "./targets/reports.js";
import {
  taskPromptGenerationAdapter,
  taskPromptVariationAdapter,
} from "./targets/task-prompts.js";

const adapters = [
  criteriaAuthoringAdapter,
  parentDependencySuggestionAdapter,
  childDependencySuggestionAdapter,
  taskPromptGenerationAdapter,
  taskPromptVariationAdapter,
  promptFeatureAuthoringAdapter,
  promptFeatureExtractionAdapter,
  judgeAdapter,
  feedbackAdapter,
  reportAdapter,
  contributionTriageAdapter,
] satisfies PromptTargetAdapter[];

const registry = new Map<QualityFamily, PromptTargetAdapter>(
  adapters.map((adapter) => [adapter.family, adapter]),
);

export interface PromptTargetDescriptor {
  adapterId: string;
  family: QualityFamily;
  variant: string;
}

export function getPromptTarget(
  family: QualityFamily,
  variant = "default",
): PromptTargetAdapter {
  const adapter = registry.get(family);
  if (!adapter) {
    throw new Error(`No prompt adapter registered for family '${family}'`);
  }
  if (!adapter.variants.includes(variant)) {
    throw new Error(
      `Unsupported variant '${variant}' for '${family}'; expected one of ${adapter.variants.join(", ")}`,
    );
  }
  return adapter;
}

export function listPromptTargets(): Array<{
  family: QualityFamily;
  variants: readonly string[];
}> {
  return QUALITY_FAMILIES.map((family) => {
    const adapter = registry.get(family);
    if (!adapter) {
      throw new Error(`No prompt adapter registered for family '${family}'`);
    }
    return { family, variants: adapter.variants };
  });
}

/**
 * Flat, JSON-serializable inventory used by manifest coverage validation.
 * One descriptor is returned for every supported family/variant pair.
 */
export function listTargets(): PromptTargetDescriptor[] {
  return QUALITY_FAMILIES.flatMap((family) => {
    const adapter = registry.get(family);
    if (!adapter) {
      throw new Error(`No prompt adapter registered for family '${family}'`);
    }
    return adapter.variants.map((variant) => ({
      adapterId: `${family}/${variant}`,
      family,
      variant,
    }));
  });
}

export function isQualityFamily(value: unknown): value is QualityFamily {
  return (
    typeof value === "string" &&
    (QUALITY_FAMILIES as readonly string[]).includes(value)
  );
}
