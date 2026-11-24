// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { PerformanceTable } from "./Statistics";
import type { AnalysisResponse } from "@/types";

const analysis: AnalysisResponse = {
  groups: [{
    task: "Build a small API",
    taskPromptId: "task-1",
    workerType: "coder-acp-copilot",
    total: 4,
    completed: 4,
    passed: 3,
    rejected: 0,
    passAtK: { 1: 0.75 },
    successAtT: [0.5, 0.75],
    iterationStats: { mean: 2, stdDev: 0.8, min: 1, max: 3 },
    durationStats: { mean: 90_000, stdDev: 30_000, min: 60_000, max: 120_000 },
  }],
  kValues: [1],
  maxT: 3,
  summary: { totalRuns: 4, completedRuns: 4, passedRuns: 3, overallPassRate: 0.75, avgIterationsToPass: 2 },
  availableCriteria: [],
  selectedCriteria: [],
  availableFeatures: [],
  selectedFeatures: [],
};

const meta = {
  component: PerformanceTable,
  args: { data: analysis },
} satisfies Meta<typeof PerformanceTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithVariation: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Mean 2.0")).toBeVisible();
    await expect(canvas.getByText("Std dev 0.8")).toBeVisible();
    await expect(canvas.getByText("Std dev 30s")).toBeVisible();
  },
};
