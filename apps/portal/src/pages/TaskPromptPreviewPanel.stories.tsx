// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router-dom";
import { TaskPromptPreviewPanel } from "./TaskPromptPreviewPanel";
import type { PromptFeatureResult, TaskPrompt } from "@/types";

/**
 * TaskPromptPreviewPanel is rendered at /task-prompts/:id. Per issue #1190 its
 * Features card shows only detected features and a detected-only count.
 *
 * The global preview decorator already mounts a single MemoryRouter, so instead
 * of nesting another router (which React Router forbids) we override the matched
 * location via the <Routes location> prop so useParams resolves the id.
 */
const meta = {
  title: "Pages/TaskPromptPreviewPanel",
  component: TaskPromptPreviewPanel,
  tags: ["ai-generated", "needs-work"],
  decorators: [
    (Story) => (
      <Routes location="/task-prompts/tp-1">
        <Route path="/task-prompts/:id" element={<Story />} />
      </Routes>
    ),
  ],
} satisfies Meta<typeof TaskPromptPreviewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const detected = (featureId: string): PromptFeatureResult => ({ featureId, detected: true, evaluated: true });
const notDetected = (featureId: string): PromptFeatureResult => ({ featureId, detected: false, evaluated: true });
const skipped = (featureId: string): PromptFeatureResult => ({ featureId, detected: false, evaluated: false });

const baseTaskPrompt: TaskPrompt = {
  _id: "tp-1",
  text: "Write a Python script that bulk-loads a CSV into an Azure Cosmos DB container.",
  createdAt: "2024-06-01T11:00:00.000Z",
};

/**
 * A run whose prompt detected 2 features out of a larger evaluated set — only
 * the detected badges and a "2 detected" count are shown.
 */
export const WithDetectedFeatures: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/task-prompts/:id", () =>
          HttpResponse.json({
            ...baseTaskPrompt,
            features: [
              detected("asks_for_python"),
              detected("asks_for_database"),
              notDetected("asks_for_frontend"),
              skipped("asks_for_iac"),
            ],
            featuresExtractedAt: "2024-06-01T12:00:00.000Z",
          }),
        ),
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("asks_for_python")).toBeVisible();
    await expect(canvas.getByText("asks_for_database")).toBeVisible();
    await expect(canvas.getByText("2 detected")).toBeVisible();
    expect(canvas.queryByText("asks_for_frontend")).toBeNull();
    expect(canvas.queryByText("asks_for_iac")).toBeNull();
  },
};

/**
 * A prompt that has never been extracted (no `features` array) shows
 * "Not extracted." — distinct from an extraction that detected nothing.
 */
export const NotExtracted: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/task-prompts/:id", () => HttpResponse.json(baseTaskPrompt)),
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Not extracted.")).toBeVisible();
  },
};

/**
 * A prompt that was extracted but matched no features shows "No features
 * detected." plus a "0 detected" count and the extraction timestamp — this is
 * deliberately distinct from the never-extracted state above.
 */
export const ExtractedNoneDetected: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/task-prompts/:id", () =>
          HttpResponse.json({
            ...baseTaskPrompt,
            features: [
              notDetected("asks_for_frontend"),
              skipped("asks_for_iac"),
            ],
            featuresExtractedAt: "2024-06-01T12:00:00.000Z",
          }),
        ),
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("No features detected.")).toBeVisible();
    await expect(canvas.getByText("0 detected")).toBeVisible();
    expect(canvas.queryByText("asks_for_frontend")).toBeNull();
    expect(canvas.queryByText("asks_for_iac")).toBeNull();
  },
};
