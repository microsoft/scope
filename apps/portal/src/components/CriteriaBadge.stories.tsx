// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { CriteriaBadge, CriteriaKindBadge, CriteriaSubjectBadge } from "./CriteriaBadge";

const meta = {
  component: CriteriaBadge,
  tags: ["ai-generated", "needs-work"],
  args: {
    criterionId: "has-automated-tests",
    prompt: "The project must include automated tests that pass.",
  },
} satisfies Meta<typeof CriteriaBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    const link = canvas.getByRole("link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/criteria/has-automated-tests");
  },
};

export const Passed: Story = {
  args: { evaluated: true, result: true, showStateLabel: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/has-automated-tests: /)).toBeVisible();
  },
};

export const Failed: Story = {
  args: { evaluated: true, result: false, showStateLabel: true },
};

export const NotEvaluated: Story = {
  args: { evaluated: true, result: undefined, showStateLabel: true },
};

export const NonLinking: Story = {
  args: { link: false },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("link")).toBeNull();
  },
};

export const WithoutPreloadedPrompt: Story = {
  args: { prompt: undefined },
};

export const GateCriterion: Story = {
  args: {
    criterionId: "has_unit_tests",
    kind: "gate",
    evaluated: true,
    result: true,
    showStateLabel: true,
    link: false,
  },
};

export const ObservationCriterion: Story = {
  args: {
    criterionId: "uses_current_sdk",
    kind: "observation",
    evaluated: true,
    result: false,
    showStateLabel: true,
    link: false,
  },
};

export const KindBadges: Story = {
  render: () => (
    <div className="flex gap-2">
      <CriteriaKindBadge kind="gate" />
      <CriteriaKindBadge kind="observation" />
    </div>
  ),
};

export const SubjectBadges: Story = {
  render: () => (
    <div className="flex gap-2">
      <CriteriaSubjectBadge subject="run" />
      <CriteriaSubjectBadge subject="iteration" />
      <CriteriaSubjectBadge subject={undefined} />
    </div>
  ),
};
