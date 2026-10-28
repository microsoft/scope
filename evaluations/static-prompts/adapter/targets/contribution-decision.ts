// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { buildDecisionInput, type DecisionCompletion } from "../../../../scripts/contribution-insights/decision.mjs";
import { parseReport } from "../../../../scripts/contribution-insights/report.mjs";
import type { ComposedPromptRequest, PromptTargetAdapter } from "../protocol.js";
import { AdapterValidationError, record } from "../validation.js";
import { loadContributionSnapshot } from "./contribution-insights.js";

function isFakeResponse(rawResponse: string): boolean {
  try {
    const response: unknown = JSON.parse(rawResponse);
    return response !== null && typeof response === "object" && "fake" in response && response.fake === true;
  } catch {
    return false;
  }
}

export async function composeContributionDecisionRequest(input: unknown): Promise<ComposedPromptRequest> {
  const value = record(input);
  const snapshot = await loadContributionSnapshot(value.snapshot);
  if (snapshot.contributions.length !== 1) {
    throw new AdapterValidationError("Contribution decisions require exactly one captured PR and its Copilot assessment");
  }
  const report = parseReport(JSON.stringify({ schemaVersion: 2, assessments: [value.assessment] }), snapshot);
  const decisionRequest = buildDecisionInput(snapshot.contributions[0], report.assessments[0]);
  return {
    model: "microsoft-decision-1",
    decisionRequest,
    // These messages are a grader projection, never a chat-completions request.
    messages: [
      { role: "system", content: JSON.stringify(decisionRequest.questions) },
      { role: "user", content: JSON.stringify(decisionRequest.state) },
    ],
    metadata: {
      adapterId: "contribution-decision/default",
      productionSources: [
        "scripts/contribution-insights/decision.mts",
        "scripts/contribution-insights/report.mts",
        "scripts/contribution-insights/collect.mts",
      ],
      insertionPoint: "decisionRequest.state.copilotInsights",
      fidelity: "partial",
    },
  };
}

export const contributionDecisionAdapter: PromptTargetAdapter<Pick<DecisionCompletion, "decision">> = {
  family: "contribution-decision",
  variants: ["default"],
  async run(input, _variant, context) {
    const request = await composeContributionDecisionRequest(input);
    if (!context.decide || !request.decisionRequest) {
      throw new AdapterValidationError("Contribution decisions require a separate Microsoft-Decision-1 transport; chat completion is not a fallback");
    }
    const completion = await context.decide(request.decisionRequest);
    return {
      request,
      rawResponse: completion.rawResponse,
      output: { decision: completion.decision },
      invocationMetadata: {
        source: isFakeResponse(completion.rawResponse) ? "fake" : "microsoft-decision-1",
        transport: "microsoft-decision-1",
        model: completion.decision.model,
        questionVersion: completion.decision.questionVersion,
        inputSha256: completion.decision.inputSha256,
        durationMs: completion.decision.durationMs,
      },
    };
  },
};
