// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import type { TaxonomyRunResult } from "@/lib/taxonomy-result";
import { TaxonomeResultView } from "./TaxonomeResultView";

const base: TaxonomyRunResult = {
  run: {
    id: "run-demo",
    scenario: { id: "request-demo", label: "Scenario", task: "Build a demo" },
    profile: { id: "profile-demo", label: "Demo profile" },
  },
  results: [
    {
      status: "succeeded",
      taxonomy: { id: "ax-taxonomy", version: "1.0.0", digest: "a".repeat(64) },
      element: { id: "observed", label: "Observed behavior", category_id: "behavior" },
      implementation: {
        type: "prompt",
        attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
      },
      input: { sha256: "b".repeat(64) },
      result: {
        state: "completed",
        observed: true,
        occurrences: [{ evidence: [{ role: "action", path: "$.events[0]" }] }],
      },
    },
    {
      status: "succeeded",
      taxonomy: { id: "ax-taxonomy", version: "1.0.0", digest: "a".repeat(64) },
      element: { id: "negative", label: "Not observed" },
      implementation: {
        type: "deterministic",
        handler: "negative",
        attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
      },
      input: { sha256: "b".repeat(64) },
      result: { state: "completed", observed: false },
    },
    {
      status: "succeeded",
      taxonomy: { id: "ax-taxonomy", version: "1.0.0", digest: "a".repeat(64) },
      element: { id: "unknown", label: "Indeterminate" },
      implementation: {
        type: "deterministic",
        handler: "unknown",
        attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
      },
      input: { sha256: "b".repeat(64) },
      result: { state: "indeterminate", reason: "Evidence was incomplete." },
    },
  ],
};

const meta = {
  title: "Components/TaxonomeResultView",
  component: TaxonomeResultView,
} satisfies Meta<typeof TaxonomeResultView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { loading: true } };
export const MixedAssessments: Story = {
  args: { result: base },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Observed behavior")).toBeVisible();
    await expect(canvas.getAllByText("Not observed")[0]).toBeVisible();
    await expect(canvas.getAllByText("Indeterminate")[0]).toBeVisible();
  },
};
export const ElementFailure: Story = {
  args: {
    result: {
      ...base,
      results: [
        {
          ...base.results[0],
          status: "failed",
          result: undefined,
          error: {
            code: "invalid_output",
            message: "Model output failed validation.",
            validation_errors: [
              {
                code: "unknown_role",
                output_path: "$.occurrences[0].evidence[0]",
                role: "unsupported",
                message: "The evidence role is not declared.",
              },
            ],
          },
        },
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Model output failed validation.")).toBeVisible();
    await expect(
      canvas.getByText("The evidence role is not declared."),
    ).toBeVisible();
  },
};
export const ArtifactUnavailable: Story = {
  args: { error: "The result artifact is missing or corrupt." },
};
export const Historical: Story = {
  args: { result: base, readOnlyLabel: "Historical" },
};
export const Deleted: Story = {
  args: { result: base, readOnlyLabel: "Deleted" },
};
