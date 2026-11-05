// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  SUMMARY_SHARE_CONTENT, FULL_SHARE_CONTENT, type RunShare, type SharedRun,
} from "shared/run-sharing";

export const exampleToken = `11111111-2222-4333-8444-555555555555.${"A".repeat(43)}`;
export const exampleShare: RunShare = {
  id: "11111111-2222-4333-8444-555555555555",
  requestId: "demo-request", runId: "demo-attempt", label: "React benchmark",
  content: { ...SUMMARY_SHARE_CONTENT },
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null, revokedAt: null,
};

export const summaryRun: SharedRun = {
  version: 1, label: "React benchmark", content: { ...SUMMARY_SHARE_CONTENT }, expiresAt: null,
  run: {
    attemptNumber: 1, status: "done", outcome: "succeeded", workerType: "coder-acp-copilot",
    model: "benchmark-model", durationMs: 42_000,
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:42.000Z",
    turns: [{
      iteration: 1, gate: "select", passed: true, timestamp: "2026-01-01T00:00:42.000Z",
      criteriaResults: [{ criterionId: "app-starts", passed: true, evaluated: true }],
    }],
  },
  artifacts: [],
};

export const fullRun: SharedRun = {
  ...summaryRun, content: { ...FULL_SHARE_CONTENT },
  prompts: [{ label: "Task", text: "Build a small React application with a working counter." }],
  run: {
    ...summaryRun.run,
    turns: summaryRun.run.turns.map((turn) => ({
      ...turn,
      codingAgentResponse: "Implemented the counter and added a focused interaction test.",
      judgeFeedback: "The application starts and its counter behaves as requested.",
      criteriaResults: turn.criteriaResults.map((result) => ({ ...result, feedback: "The development server starts successfully." })),
    })),
  },
};
