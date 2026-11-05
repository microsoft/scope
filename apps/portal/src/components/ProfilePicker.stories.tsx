// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import type { ProfileWithVersion } from "@/types";
import { Label } from "@/components/ui/label";
import { ProfilePicker } from "./ProfilePicker";

const profiles: ProfileWithVersion[] = [
  { id: "fast", name: "Fast configuration", model: "fast-model" },
  { id: "quality", name: "Quality configuration", model: "quality-model" },
].map(({ id, name, model }) => ({
  _id: id,
  name,
  latestVersion: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  version: {
    _id: `${id}-v2`,
    profileId: id,
    version: 2,
    workerType: "coder-acp-copilot",
    model,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
}));

const meta = {
  component: ProfilePicker,
  tags: ["ai-generated", "needs-work"],
  args: {
    profiles,
    selectedProfileId: null,
    onSelect: () => {},
    workerNameById: new Map([["coder-acp-copilot", "GitHub Copilot CLI"]]),
  },
  decorators: [(Story) => <div className="min-h-80 max-w-lg p-6"><Story /></div>],
} satisfies Meta<typeof ProfilePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BaseProfile: Story = {
  play: async ({ canvas }) => {
    const input = canvas.getByPlaceholderText("Search existing profiles…");
    await userEvent.type(input, "quality-model");
    await expect(canvas.getAllByRole("listitem")).toHaveLength(1);
    await expect(canvas.getByText("Quality configuration")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("listitem")).not.toBeInTheDocument();
  },
};

export const VariationProfile: Story = {
  render: function Variation(args) {
    const [selectedProfileId, setSelectedProfileId] = useState<string | null>("fast");
    return (
      <div className="space-y-1">
        <Label htmlFor="variation-profile">Variation #1</Label>
        <ProfilePicker
          {...args}
          inputId="variation-profile"
          selectedProfileId={selectedProfileId}
          onSelect={setSelectedProfileId}
        />
        <p>{profiles.find((profile) => profile._id === selectedProfileId)?.name}</p>
      </div>
    );
  },
  play: async ({ canvas }) => {
    const input = canvas.getByLabelText("Variation #1");
    await userEvent.type(input, "quality-model");
    await expect(canvas.getByText("Fast configuration")).toBeVisible();
    await expect(canvas.getAllByRole("listitem")).toHaveLength(1);
    await userEvent.clear(input);
    await userEvent.type(input, "GitHub Copilot CLI");
    await expect(canvas.getAllByRole("listitem")).toHaveLength(2);
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{ArrowDown}{Enter}");
    await expect(input).toHaveValue("");
    await expect(canvas.queryByRole("listitem")).not.toBeInTheDocument();
    await expect(canvas.getByText("Quality configuration")).toBeVisible();
  },
};

export const NoMatchingProfiles: Story = {
  play: async ({ canvas }) => {
    await userEvent.type(canvas.getByPlaceholderText("Search existing profiles…"), "no-match");
    await expect(canvas.getByText("No matching profiles")).toBeVisible();
  },
};

export const NoAvailableProfiles: Story = {
  args: { profiles: [] },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByPlaceholderText("Search existing profiles…"));
    await expect(canvas.getByText("No profiles available")).toBeVisible();
  },
};
