// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";

import { SkillRevisionLinks } from "./SkillRevisionLinks";

const meta = {
  component: SkillRevisionLinks,
  args: {
    references: [
      "microsoft/example-skills/react-testing@1234567890abcdef",
      "microsoft/example-skills/accessibility@abcdef1234567890",
    ],
  },
} satisfies Meta<typeof SkillRevisionLinks>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Versioned: Story = {};

export const LegacyUnversioned: Story = {
  args: {
    references: ["legacy/skill"],
  },
};
