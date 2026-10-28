// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import type {
  Assessment,
  DeterministicHandler,
  TaxonomyInput as LoadedTaxonomyInput,
} from "taxonomy-engine";

export const malformedInvocationConfigSchema = z.object({}).strict();
export type MalformedInvocationConfig = z.infer<
  typeof malformedInvocationConfigSchema
>;

/** Evaluates only explicit tool-input validation evidence, never prose/outcome. */
function evaluateMalformedInvocation(
  input: LoadedTaxonomyInput,
): Assessment {
  const occurrences: Array<{
    evidence: Array<{ role: string; path: string }>;
  }> = [];
  let hasUnknownValidation = false;

  for (const [stepIndex, step] of input.atif.steps.entries()) {
    for (const [callIndex, call] of (step.tool_calls ?? []).entries()) {
      const evidence = call.extra?.scope;
      const validation = evidence?.input_validation;
      if (!validation || validation.status === "unknown") {
        hasUnknownValidation = true;
        continue;
      }
      if (validation.status === "valid") continue;

      const callPath = `$.steps[${stepIndex}].tool_calls[${callIndex}]`;
      occurrences.push({
        evidence: [
          { role: "call", path: callPath },
          ...validation.issues.map((_issue, issueIndex) => ({
            role: "issue",
            path:
              `${callPath}.extra.scope.input_validation.issues[${issueIndex}]`,
          })),
        ],
      });
    }
  }

  if (occurrences.length) {
    return { state: "completed", observed: true, occurrences };
  }
  if (
    input.atif.extra?.scope?.trajectory_state !== "complete" ||
    hasUnknownValidation
  ) {
    return {
      state: "indeterminate",
      reason: "Tool-call input validation evidence is incomplete or unknown.",
    };
  }
  return { state: "completed", observed: false };
}

/** Registry entry referenced by YAML as `scope/malformed-invocation-v1`. */
export const malformedInvocationHandler: DeterministicHandler<
  MalformedInvocationConfig,
  Assessment
> = {
  configSchema: malformedInvocationConfigSchema,
  evaluate: evaluateMalformedInvocation,
};
