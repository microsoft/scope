// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { taxonomySchema } from "./taxonomy.js";

describe("taxonomySchema", () => {
  const validFixture = {
    meta: {
      generatedAt: "2025-02-01T12:00:00Z",
      schemaVersion: "1.0.0",
      runId: "run-123",
      requestId: "req-456",
    },
    scorecard: {
      summary: "The agent usually succeeds but struggles with recovery quality.",
      profileResults: [
        {
          profileId: "profile-best",
          select: "best",
          taskOutcome: "success",
          overallScore: 92,
          dimensions: [
            {
              name: "Correctness",
              score: 95,
              rationale: "Implemented the requested behavior fully.",
              evidence: ["All acceptance criteria passed", "No regressions observed"],
            },
          ],
        },
      ],
      crossProfileInsights: [
        "The agent communicates clearly across profiles.",
        "Stress conditions reduce recovery quality.",
      ],
    },
    behaviorAnalysis: {
      patterns: [
        {
          id: "pattern-1",
          category: "strength",
          title: "Consistent planning",
          description: "The agent outlines a clear plan before making changes.",
          frequency: 0.75,
          impact: "high",
          evidence: [
            {
              runId: "run-123",
              iteration: 1,
              excerpt: "Plan: inspect the failing endpoint, then patch the handler.",
            },
          ],
        },
      ],
      agentPersonality: {
        communicationStyle: "Concise and structured",
        problemSolvingApproach: "Hypothesis-driven debugging",
        errorRecoveryBehavior: "Retries with targeted fixes after inspecting evidence",
      },
    },
    actionList: {
      fix: [
        {
          id: "action-1",
          title: "Stabilize recovery prompts",
          priority: "critical",
          description: "Reduce failures when the first attempt is rejected.",
          ownership: "prompt-engineer",
          relatedPatterns: ["pattern-1"],
          suggestedApproach: "Add explicit fallback guidance for failed first passes.",
        },
      ],
      improve: [
        {
          id: "action-2",
          title: "Expand planning examples",
          priority: "medium",
          description: "Reinforce successful planning behavior.",
          ownership: "agent-team",
          relatedPatterns: ["pattern-1"],
          suggestedApproach: "Fine-tune on traces with strong upfront decomposition.",
        },
      ],
      investigate: [
        {
          id: "action-3",
          title: "Review profile variance",
          priority: "low",
          description: "Understand why profile-specific regressions appear sporadically.",
          ownership: "scenario-author",
          relatedPatterns: ["pattern-1"],
          suggestedApproach: "Compare scenario wording against affected profile runs.",
        },
      ],
    },
  };

  it("accepts a valid taxonomy fixture", () => {
    const result = taxonomySchema.safeParse(validFixture);
    expect(result.success).toBe(true);
  });

  it("rejects fixtures missing required fields with precise paths", () => {
    const invalidFixture = {
      ...validFixture,
      scorecard: {
        ...validFixture.scorecard,
        profileResults: [
          {
            ...validFixture.scorecard.profileResults[0],
            dimensions: [
              {
                name: "Correctness",
                score: 95,
                evidence: ["All acceptance criteria passed"],
              },
            ],
          },
        ],
      },
      behaviorAnalysis: {
        ...validFixture.behaviorAnalysis,
        agentPersonality: {
          communicationStyle: "Concise and structured",
          errorRecoveryBehavior: "Retries with targeted fixes after inspecting evidence",
        },
      },
    };

    const result = taxonomySchema.safeParse(invalidFixture);
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected invalid taxonomy fixture to fail parsing");
    }

    const issuePaths = result.error.issues.map((issue) => issue.path);
    expect(issuePaths).toContainEqual([
      "scorecard",
      "profileResults",
      0,
      "dimensions",
      0,
      "rationale",
    ]);
    expect(issuePaths).toContainEqual([
      "behaviorAnalysis",
      "agentPersonality",
      "problemSolvingApproach",
    ]);
  });

  it("enforces enum values", () => {
    const invalidFixture = {
      ...validFixture,
      actionList: {
        ...validFixture.actionList,
        fix: [
          {
            ...validFixture.actionList.fix[0],
            priority: "urgent",
          },
        ],
      },
    };

    const result = taxonomySchema.safeParse(invalidFixture);
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected invalid enum fixture to fail parsing");
    }

    expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
      "actionList",
      "fix",
      0,
      "priority",
    ]);
  });
});
