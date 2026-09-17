// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { CriteriaConfig, CriterionResult, DependencyGraph, TokenManagerClient } from "shared";

export interface FeedbackContext {
  judgeResults: CriterionResult[];
  criteriaGraph: DependencyGraph;
  criteriaRegistry: Map<string, CriteriaConfig>;
  personaInstructions?: string;
  maxCriteria?: number;
  includeDescendantGuard?: boolean;
}

export interface FeedbackResult {
  feedback: string;
  selectedCriteriaIds: string[];
}

export interface FeedbackPromptRequest {
  systemPrompt: string;
  userPrompt: string;
  fallbackFeedback: string;
  selectedCriteriaIds: string[];
}

export interface FeedbackPromptInput {
  judgeResults: CriterionResult[];
  criteria: CriteriaConfig[];
  personaInstructions?: string;
  maxCriteria?: number;
  includeDescendantGuard?: boolean;
}

/**
 * Default instructions for feedback generation
 */
const DEFAULT_INSTRUCTIONS = `You are providing feedback to a developer on their work. Your role is to help them improve their code iteratively.

CRITICAL RULES:
- Do NOT mention any "evaluation", "judge", "criteria", "assessment", or "review process"
- Do NOT use phrases like "based on the evaluation" or "the review shows"
- Write as if YOU personally looked at their code and are giving direct feedback
- Address them directly using "you"
- Be encouraging about what's good, clear about what needs fixing
- NEVER ask questions - the developer cannot respond to you
- Give DIRECT COMMANDS and specific instructions for what to do next
- Be concise and action-oriented
- Prioritize the most important missing items first

Examples of good feedback:
- "I don't see any package.json file. Create one with express as a dependency."
- "The server code looks good, but it's not listening on a port yet. Add app.listen(3000) at the end."

Examples of bad feedback:
- "According to the evaluation criteria, the code lacks a package.json." (too formal, mentions evaluation)
- "Can you add a package.json file?" (asking a question they can't answer)
- "It would be nice if..." (too indirect)`;

export function buildFeedbackPromptRequest(
  context: FeedbackContext,
): FeedbackPromptRequest | null {
  const {
    judgeResults,
    criteriaGraph,
    criteriaRegistry,
    personaInstructions,
    maxCriteria = 1,
    includeDescendantGuard = true,
  } = context;

  const rootFailures = criteriaGraph.getRootFailures(judgeResults);
  if (rootFailures.length === 0) return null;

  const selectedFailures = rootFailures.slice(0, maxCriteria);
  const selectedCriteriaIds = selectedFailures.map(
    (result) => result.criterionId,
  );
  const contextParts = ["What needs work:"];
  for (const result of selectedFailures) {
    contextParts.push(`- ${result.feedback}`);
  }

  const failureContext = contextParts.join("\n");

  let systemPrompt = personaInstructions || DEFAULT_INSTRUCTIONS;
  if (includeDescendantGuard) {
    const descendantIds = new Set<string>();
    for (const criterionId of selectedCriteriaIds) {
      for (const descendantId of criteriaGraph.getDescendants(criterionId)) {
        descendantIds.add(descendantId);
      }
    }
    const descendantPrompts = [...descendantIds]
      .map((id) => criteriaRegistry.get(id)?.prompt)
      .filter((prompt): prompt is string => typeof prompt === "string");

    if (descendantPrompts.length > 0) {
      systemPrompt += `\n\n**CRITICAL CONSTRAINT**: Do NOT give any hints, clues, or directions about these requirements (they haven't been introduced yet):
`;
      for (const prompt of descendantPrompts) {
        systemPrompt += `- ${prompt}\n`;
      }
      systemPrompt += `\nFocus ONLY on fixing the immediate issues. Do not mention anything related to the requirements listed above.`;
    }
  }

  return {
    systemPrompt,
    userPrompt: `Based on the following issues with the code, provide clear, actionable feedback to the developer:

${failureContext}

Your feedback:`,
    fallbackFeedback: failureContext,
    selectedCriteriaIds,
  };
}

export function buildFeedbackPromptRequestFromCriteria(
  input: FeedbackPromptInput,
): FeedbackPromptRequest | null {
  return buildFeedbackPromptRequest({
    judgeResults: input.judgeResults,
    criteriaGraph: new DependencyGraph(input.criteria),
    criteriaRegistry: new Map(
      input.criteria.map((criterion) => [criterion.id, criterion]),
    ),
    personaInstructions: input.personaInstructions,
    maxCriteria: input.maxCriteria,
    includeDescendantGuard: input.includeDescendantGuard,
  });
}

/**
 * FeedbackGenerator: Converts judge results into natural language feedback
 *
 * Key features:
 * - Filters to root-cause failures only (no cascading failures)
 * - Limits to maxCriteria most important failures
 * - Guards against hinting about descendant criteria
 * - Generates natural, coaching-style feedback
 */
export class FeedbackGenerator {
  private model: string;
  private tokenClient: TokenManagerClient;

  constructor(model?: string) {
    this.model = model || process.env.FEEDBACK_MODEL || "gpt-5.4-mini";
    this.tokenClient = new TokenManagerClient();
  }

  async generateFeedback(
    context: FeedbackContext
  ): Promise<FeedbackResult> {
    const request = buildFeedbackPromptRequest(context);
    if (!request) {
      // All passed or no failures - should not happen but handle gracefully
      return {
        feedback: "All requirements met.",
        selectedCriteriaIds: [],
      };
    }

    // Generate feedback using LLM
    const feedback = await this.generateNaturalFeedback(
      request.systemPrompt,
      request.userPrompt,
      request.fallbackFeedback,
    );

    return {
      feedback,
      selectedCriteriaIds: request.selectedCriteriaIds,
    };
  }

  protected async generateNaturalFeedback(
    systemPrompt: string,
    userPrompt: string,
    fallbackFeedback: string,
  ): Promise<string> {
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    const client = new CopilotClient({ gitHubToken: githubToken });
    let fullResponse = "";

    try {
      const session = await client.createSession({
        model: this.model,
        streaming: true,
        systemMessage: { mode: "replace", content: systemPrompt },
      });

      session.on((event: SessionEvent) => {
        if (event.type === "assistant.message_delta") {
          fullResponse += event.data.deltaContent;
        }
      });

      const timeout = parseInt(process.env.JUDGE_TIMEOUT || "300000");
      await session.sendAndWait({ prompt: userPrompt }, timeout);
      await client.stop();

      return fullResponse.trim();
    } catch (error) {
      console.error("[feedback-generator] Error:", error);
      // Fallback to raw feedback if LLM fails
      return fallbackFeedback;
    }
  }
}
