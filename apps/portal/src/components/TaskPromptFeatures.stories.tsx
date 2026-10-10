// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { http, HttpResponse } from "msw";
import { TaskPromptFeatures } from "./TaskPromptFeatures";
import type { PromptFeatureResult, TaskPrompt } from "@/types";

/**
 * TaskPromptFeatures renders prompt-feature extraction results. Per issue #1190
 * the UI now shows **only detected** features — the "Not detected" and
 * "Skipped" groups are intentionally hidden everywhere to remove noise.
 */
const meta = {
  title: "Components/TaskPromptFeatures",
  component: TaskPromptFeatures,
  tags: ["ai-generated", "needs-work"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof TaskPromptFeatures>;

export default meta;
type Story = StoryObj<typeof meta>;

const detected = (featureId: string): PromptFeatureResult => ({ featureId, detected: true, evaluated: true });
const notDetected = (featureId: string): PromptFeatureResult => ({ featureId, detected: false, evaluated: true });
const skipped = (featureId: string): PromptFeatureResult => ({ featureId, detected: false, evaluated: false });

// A realistic mix: a Python/Cosmos script detects a couple of features while
// most of the registry (frontend, Next.js, IaC) does not apply.
const mixedFeatures: PromptFeatureResult[] = [
  detected("asks_for_python"),
  detected("asks_for_database"),
  notDetected("asks_for_frontend"),
  notDetected("asks_for_nextjs"),
  skipped("asks_for_iac"),
];

const registry = [
  { id: "asks_for_python", prompt: "The task asks for Python" },
  { id: "asks_for_database", prompt: "The task asks for a database" },
  { id: "asks_for_frontend", prompt: "The task asks for a frontend UI" },
  { id: "asks_for_nextjs", prompt: "The task asks for Next.js" },
  { id: "asks_for_iac", prompt: "The task asks for infrastructure as code" },
];

const taskPromptWith = (id: string, features: PromptFeatureResult[]): TaskPrompt => ({
  _id: id,
  text: "Write a Python script that bulk-loads a CSV into an Azure Cosmos DB container.",
  features,
  featuresExtractedAt: "2024-06-01T12:00:00.000Z",
  createdAt: "2024-06-01T11:00:00.000Z",
});

/**
 * Entity mode with a stored extraction that detected 2 of 5 evaluated features.
 * Only the detected badges render; the not-detected and skipped ids are absent.
 */
export const OnlyDetected: Story = {
  args: { taskPromptId: "tp-cosmos-script", autoExtract: false },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/task-prompts/:id", () =>
          HttpResponse.json(taskPromptWith("tp-cosmos-script", mixedFeatures)),
        ),
        http.get("/api/v1/prompt-features", () => HttpResponse.json(registry)),
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("asks_for_python")).toBeVisible();
    await expect(canvas.getByText("asks_for_database")).toBeVisible();
    await expect(canvas.getByText("Detected (2)")).toBeVisible();
    // The noisy not-detected / skipped features must not render.
    expect(canvas.queryByText("asks_for_frontend")).toBeNull();
    expect(canvas.queryByText("asks_for_nextjs")).toBeNull();
    expect(canvas.queryByText("asks_for_iac")).toBeNull();
  },
};

/**
 * Entity mode where extraction ran but detected nothing. The Detected group is
 * hidden entirely (no empty placeholder) while Manual Selection stays available.
 */
export const NoDetectedFeatures: Story = {
  args: { taskPromptId: "tp-no-detected", autoExtract: false },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/task-prompts/:id", () =>
          HttpResponse.json(
            taskPromptWith("tp-no-detected", [
              notDetected("asks_for_frontend"),
              notDetected("asks_for_nextjs"),
              skipped("asks_for_iac"),
            ]),
          ),
        ),
        http.get("/api/v1/prompt-features", () => HttpResponse.json(registry)),
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Manual Selection")).toBeVisible();
    // No Detected (...) header and no not-detected badges.
    expect(canvas.queryByText(/^Detected \(/)).toBeNull();
    expect(canvas.queryByText("asks_for_frontend")).toBeNull();
  },
};

/**
 * Text mode (no entity) auto-extracts from raw text and shows read-only badges,
 * again limited to detected features only.
 */
export const TextMode: Story = {
  args: {
    text: "Write a Python script that bulk-loads a CSV into an Azure Cosmos DB container.",
    autoExtract: true,
  },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/v1/prompt-features/extract-from-text", () =>
          HttpResponse.json({
            features: mixedFeatures,
            featuresExtractedAt: "2024-06-01T12:00:00.000Z",
            cached: false,
          }),
        ),
        http.get("/api/v1/prompt-features", () => HttpResponse.json(registry)),
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("asks_for_python")).toBeVisible();
    await expect(canvas.getByText("asks_for_database")).toBeVisible();
    expect(canvas.queryByText("asks_for_frontend")).toBeNull();
    expect(canvas.queryByText("asks_for_iac")).toBeNull();
  },
};
