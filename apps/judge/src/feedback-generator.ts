// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { CriteriaConfig, CriterionResult } from "@scope/core";
import { DependencyGraph } from "@scope/criteria";
import { TokenManagerClient } from "@scope/secrets";

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
    this.model = model || process.env.FEEDBACK_MODEL || "gpt-4.1";
    this.tokenClient = new TokenManagerClient();
  }

  async generateFeedback(
    context: FeedbackContext
  ): Promise<FeedbackResult> {
    const {
      judgeResults,
      criteriaGraph,
      criteriaRegistry,
      personaInstructions,
      maxCriteria = 1,
      includeDescendantGuard = true,
    } = context;

    // 1. Filter to root failures only
    const rootFailures = criteriaGraph.getRootFailures(judgeResults);

    if (rootFailures.length === 0) {
      // All passed or no failures - should not happen but handle gracefully
      return {
        feedback: "All requirements met.",
        selectedCriteriaIds: [],
      };
    }

    // 2. Limit to maxCriteria
    const selectedFailures = rootFailures.slice(0, maxCriteria);
    const selectedCriteriaIds = selectedFailures.map((r) => r.criterionId);

    // 3. Build context from failures
    const contextParts = ["What needs work:"];
    for (const result of selectedFailures) {
      contextParts.push(`- ${result.feedback}`);
    }
    const failureContext = contextParts.join("\n");

    // 4. Build system prompt
    const instructions = personaInstructions || DEFAULT_INSTRUCTIONS;
    const systemPrompt = this.buildSystemPrompt(
      instructions,
      selectedCriteriaIds,
      criteriaGraph,
      criteriaRegistry,
      includeDescendantGuard
    );

    // 5. Generate feedback using LLM
    const feedback = await this.generateNaturalFeedback(
      systemPrompt,
      failureContext
    );

    return {
      feedback,
      selectedCriteriaIds,
    };
  }

  private buildSystemPrompt(
    baseInstructions: string,
    selectedCriteriaIds: string[],
    criteriaGraph: DependencyGraph,
    criteriaRegistry: Map<string, CriteriaConfig>,
    includeDescendantGuard: boolean
  ): string {
    let systemPrompt = baseInstructions;

    // Add descendant guard if enabled
    if (includeDescendantGuard) {
      const descendantPrompts = this.getDescendantPrompts(
        selectedCriteriaIds,
        criteriaGraph,
        criteriaRegistry
      );

      if (descendantPrompts.length > 0) {
        systemPrompt += `\n\n**CRITICAL CONSTRAINT**: Do NOT give any hints, clues, or directions about these requirements (they haven't been introduced yet):
`;
        for (const prompt of descendantPrompts) {
          systemPrompt += `- ${prompt}\n`;
        }
        systemPrompt += `\nFocus ONLY on fixing the immediate issues. Do not mention anything related to the requirements listed above.`;
      }
    }

    return systemPrompt;
  }

  private getDescendantPrompts(
    criteriaIds: string[],
    graph: DependencyGraph,
    registry: Map<string, CriteriaConfig>
  ): string[] {
    const descendantPrompts: string[] = [];
    const allDescendants = new Set<string>();

    // Collect all descendants of selected criteria
    for (const cid of criteriaIds) {
      const descendants = graph.getDescendants(cid);
      for (const desc of descendants) {
        allDescendants.add(desc);
      }
    }

    // Get prompts for descendants
    for (const descId of allDescendants) {
      const criteria = registry.get(descId);
      if (criteria) {
        descendantPrompts.push(criteria.prompt);
      }
    }

    return descendantPrompts;
  }

  private async generateNaturalFeedback(
    systemPrompt: string,
    failureContext: string
  ): Promise<string> {
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    const client = new CopilotClient({ githubToken });
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

      const userPrompt = `Based on the following issues with the code, provide clear, actionable feedback to the developer:

${failureContext}

Your feedback:`;

      const timeout = parseInt(process.env.JUDGE_TIMEOUT || "300000");
      await session.sendAndWait({ prompt: userPrompt }, timeout);
      await client.stop();

      return fullResponse.trim();
    } catch (error) {
      console.error("[feedback-generator] Error:", error);
      // Fallback to raw feedback if LLM fails
      return failureContext;
    }
  }
}
