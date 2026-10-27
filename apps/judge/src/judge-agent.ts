// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  CriteriaConfig,
  CriterionResult,
  ConversationTurn,
  DetailedEvaluationResult,
  DependencyGraph,
  GateId,
  IterationToolCalls,
} from "shared";
import { getCriteriaProvider } from "shared/criteria-provider-factory";
import { createJudgeStrategy } from "./judge-strategies.js";
import { FeedbackGenerator } from "./feedback-generator.js";

export interface EvaluationInput {
  workspacePath: string;
  criteria: string[];
  conversationHistory: ConversationTurn[];
  personaInstructions?: string;
  /** Called when an individual criterion result is available (for real-time progress) */
  onProgress?: (result: CriterionResult) => void;
  /** Which gate is being evaluated. Defaults to select. */
  gate?: GateId;
  /** The coding agent's captured tool calls/outputs grouped per iteration across
   *  the whole run (1..N), exposed to the judge via list_tool_calls /
   *  search_tool_outputs / get_tool_output. */
  iterationToolCalls?: IterationToolCalls[];
  /** The run's project — scopes criteria resolution to that project (per-project isolation). */
  projectId?: string;
  /** The coding agent's response (prose) for the iteration being judged, exposed to the judge via read_agent_response. */
  currentAgentResponse?: string;
}

export interface EvaluationResult {
  passed: boolean;
  feedback: string;
  criteriaResults: CriterionResult[];  // Per-criterion breakdown
}

/**
 * Whether criteria are resolved through the project-scoped REST API.
 * The filesystem provider (local dev) is single-tenant and ignores projectId.
 */
export function usesProjectScopedCriteria(): boolean {
  return Boolean(process.env.CRITERIA_API_URL);
}

/**
 * Fail closed when a run reaches the judge without a project scope.
 *
 * Criteria are isolated per project, so an unscoped REST lookup would
 * silently resolve the legacy/global criteria and produce a wrong evaluation
 * instead of an error (issue #1303).
 *
 * @param projectId - The run's project, if known.
 * @throws When criteria come from the REST API and `projectId` is absent.
 */
export function assertProjectScope(projectId: string | undefined): void {
  if (!projectId && usesProjectScopedCriteria()) {
    throw new Error(
      "Evaluation has no projectId — refusing to resolve criteria outside a project scope",
    );
  }
}

/**
 * Evaluate workspace against criteria using the sophisticated DAG system
 *
 * This function:
 * 1. Resolves criteria IDs from the provider (with ancestor dependencies)
 * 2. Builds criteria graph and validates DAG
 * 3. Selects judge strategy from environment (bundled or independent)
 * 4. Runs judge evaluation
 * 5. Generates natural language feedback if not all passed
 */
export async function evaluateWorkspace(
  input: EvaluationInput
): Promise<EvaluationResult> {
  // 1. Load strategy config from environment
  const strategyType =
    (process.env.JUDGE_STRATEGY as "bundled" | "independent") || "bundled";
  const maxParallelism = parseInt(process.env.JUDGE_MAX_PARALLELISM || "3");

  // 2. Load feedback config from environment
  const maxCriteria = parseInt(process.env.FEEDBACK_MAX_CRITERIA || "1");
  const includeDescendantGuard =
    process.env.FEEDBACK_DESCENDANT_GUARD !== "false";

  // 3. Resolve criteria IDs from provider (with ancestor dependencies)
  assertProjectScope(input.projectId);
  let normalizedCriteria: CriteriaConfig[];
  try {
    const provider = getCriteriaProvider(input.projectId);
    normalizedCriteria = await provider.resolveWithAncestors(input.criteria);
    console.log(
      `[judge-agent] Loaded ${normalizedCriteria.length} criteria (including ancestors) from provider`
    );
  } catch (error) {
    console.error("[judge-agent] Failed to resolve criteria:", error);
    throw new Error(
      `Failed to resolve criteria: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 4. Build criteria graph (validates DAG)
  let criteriaGraph: DependencyGraph;
  try {
    criteriaGraph = new DependencyGraph(normalizedCriteria);
    console.log(
      `[judge-agent] Built criteria DAG with ${normalizedCriteria.length} nodes`
    );
  } catch (error) {
    console.error("[judge-agent] Failed to build criteria graph:", error);
    throw new Error(
      `Invalid criteria dependencies: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 5. Select and configure strategy
  const strategy = createJudgeStrategy(strategyType, { maxParallelism });
  console.log(
    `[judge-agent] Using ${strategyType} strategy${strategyType === "independent" ? ` (parallelism=${maxParallelism})` : ""}`
  );

  // 6. Run judge evaluation
  let judgeResult: DetailedEvaluationResult;
  try {
    judgeResult = await strategy.evaluate({
      workspacePath: input.workspacePath,
      criteria: normalizedCriteria,
      criteriaGraph,
      conversationHistory: input.conversationHistory,
      personaInstructions: input.personaInstructions,
      onProgress: input.onProgress,
      gate: input.gate,
      iterationToolCalls: input.iterationToolCalls,
      currentAgentResponse: input.currentAgentResponse,
    });

    console.log(
      `[judge-agent] Evaluation complete: ${judgeResult.results.filter((r) => r.passed).length}/${judgeResult.results.length} criteria passed`
    );
  } catch (error) {
    console.error("[judge-agent] Judge evaluation failed:", error);
    throw new Error(
      `Judge evaluation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 7. Generate feedback (if not all passed)
  let feedback: string;
  if (judgeResult.allPassed) {
    feedback = "All requirements met.";
    console.log("[judge-agent] All criteria passed");
  } else {
    try {
      const feedbackGen = new FeedbackGenerator();
      const feedbackResult = await feedbackGen.generateFeedback({
        judgeResults: judgeResult.results,
        criteriaGraph,
        criteriaRegistry: new Map(
          normalizedCriteria.map((c) => [c.id, c])
        ),
        personaInstructions: input.personaInstructions,
        maxCriteria,
        includeDescendantGuard,
      });

      feedback = feedbackResult.feedback;
      console.log(
        `[judge-agent] Generated feedback for ${feedbackResult.selectedCriteriaIds.length} root failures`
      );
    } catch (error) {
      console.error("[judge-agent] Feedback generation failed:", error);
      // Fallback to raw feedback from judge
      const failed = judgeResult.results.filter((r) => !r.passed);
      feedback =
        failed.length > 0
          ? failed
              .slice(0, maxCriteria)
              .map((r) => r.feedback)
              .join("\n\n")
          : "Requirements not met.";
    }
  }

  return {
    passed: judgeResult.allPassed,
    feedback,
    criteriaResults: judgeResult.results,
  };
}
