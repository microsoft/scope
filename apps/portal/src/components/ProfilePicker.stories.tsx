// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { ProfilePicker } from "./ProfilePicker";
import type { ProfileWithVersion } from "@/types";

const longName = "A descriptive profile name that should remain visible whenever the picker has enough room to show it in full";
const profile: ProfileWithVersion = {
  _id: "profile-1",
  name: longName,
  latestVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  version: {
    _id: "profile-version-1",
    profileId: "profile-1",
    version: 1,
    workerType: "coder-acp-copilot",
    model: "gpt-5.6-sol",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
};

const meta = {
  component: ProfilePicker,
  args: {
    profiles: [profile],
    selectedProfileId: null,
    onSelect: () => {},
  },
  decorators: [(Story) => (
    <div className="w-[800px] max-w-full">
      <Story />
    </div>
  )],
} satisfies Meta<typeof ProfilePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LongName: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByPlaceholderText("Search existing profiles…"));
    await expect(canvas.getByText(longName)).toHaveAttribute("title", longName);
  },
};
