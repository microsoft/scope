// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentType } from "react";
import { expect } from "storybook/test";
import { AuthContext, type AuthContextValue } from "@/contexts/AuthContext";
import { signedOutAuth } from "@/contexts/authFixtures";
import { ApiError } from "@/lib/api";
import { RequireAuth } from "./RequireAuth";

function withAuth(auth: Partial<AuthContextValue>) {
  return (Story: ComponentType) => (
    <AuthContext.Provider value={{ ...signedOutAuth, ...auth }}>
      <Story />
    </AuthContext.Provider>
  );
}

const meta = {
  component: RequireAuth,
  tags: ["ai-generated"],
  args: { children: <div>Scope application</div> },
} satisfies Meta<typeof RequireAuth>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Resolving: Story = {
  decorators: [withAuth({ status: "resolving" })],
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Connecting to Scope…")).toBeVisible();
  },
};

export const NotEnrolled: Story = {
  decorators: [withAuth({ status: "denied", error: new ApiError("Not enrolled", 403, "user_not_enrolled") })],
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Log in" })).toBeVisible();
  },
};

export const Disabled: Story = {
  decorators: [withAuth({ status: "denied", error: new ApiError("Disabled", 403, "user_disabled") })],
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Account disabled")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Retry" })).toBeNull();
  },
};

export const Unavailable: Story = {
  decorators: [withAuth({ status: "error", error: new ApiError("Unavailable", 503) })],
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible();
  },
};
