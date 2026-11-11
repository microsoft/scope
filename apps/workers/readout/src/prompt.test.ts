// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { ExperimentEvidence } from "./readout-builder.js";
import {
  composeReadoutPromptEvidence,
  composeReadoutUserPrompt,
  READOUT_SYSTEM_PROMPT,
} from "./prompt.js";

function largeEvidence(): ExperimentEvidence {
  return {
    experimentId: "experiment-1",
    experimentExecutionId: "execution-1",
    runs: Array.from({ length: 9 }, (_, index) => ({
      request: {
        _id: `request-${index}`,
        projectId: "project-1",
        scenario: {
          task: "task".repeat(10_000),
          criteria: [`criterion-${index}`],
        },
        workerType: "coder-acp-copilot",
        model: "claude-opus-5.5",
        profileId: `profile-${index % 3}@1`,
        createdAt: new Date(),
        priority: 0,
      },
      run: {
        _id: `run-${index}`,
        attemptNumber: 1,
        status: "done",
        outcome: "succeeded",
        result: "result".repeat(20_000),
        turns: [{
          iteration: 1,
          codingAgentResponse: "response".repeat(20_000),
          judgeFeedback: "feedback".repeat(20_000),
          passed: true,
          snapshotUrl: "https://storage.invalid/snapshot.tar.gz",
          timestamp: new Date(),
        }],
      },
      criteria: [{
        _id: `criterion-document-${index}`,
        id: `criterion-${index}`,
        projectId: "project-1",
        name: `Criterion ${index}`,
        prompt: "criterion prompt".repeat(10_000),
        kind: "observation",
        subject: "run",
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      trajectories: [{
        iteration: 1,
        trajectory: { events: ["trajectory".repeat(100_000)] },
      }],
    })),
  };
}

describe("Experiment readout prompt composition", () => {
  it("preserves every exact identity while bounding large evidence bodies", () => {
    const evidence = largeEvidence();
    const projected = composeReadoutPromptEvidence(evidence);
    const prompt = composeReadoutUserPrompt(evidence);

    expect(projected.runs).toHaveLength(9);
    expect(projected.runs.map(({ request }) => request._id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `request-${index}`),
    );
    expect(projected.runs.map(({ run }) => run._id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `run-${index}`),
    );
    expect(prompt.length).toBeLessThan(250_000);
    expect(
      Math.ceil((READOUT_SYSTEM_PROMPT.length + prompt.length) / 3),
    ).toBeLessThan(100_000);
    expect(prompt).toContain("... [truncated]");
  });

  it("keeps the empty exact-execution envelope stable", () => {
    const evidence: ExperimentEvidence = {
      experimentId: "experiment-1",
      experimentExecutionId: "execution-1",
      runs: [],
    };

    expect(composeReadoutPromptEvidence(evidence)).toEqual(evidence);
  });
});
