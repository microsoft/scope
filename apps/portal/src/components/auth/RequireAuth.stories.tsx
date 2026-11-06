// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentType } from "react";
import { expect, fn, userEvent } from "storybook/test";
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
  tags: ["ai-generated", "needs-work"],
  parameters: { layout: "fullscreen" },
  args: { children: <div>Scope application</div> },
} satisfies Meta<typeof RequireAuth>;

export default meta;
type Story = StoryObj<typeof meta>;

const login = fn(async () => {});
export const SignedOut: Story = {
  decorators: [withAuth({ login })],
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Welcome to Scope" })).toBeVisible();
    await expect(canvas.queryByText("Scope application")).toBeNull();
    await expect(login).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Log in" }));
    await expect(login).toHaveBeenCalledTimes(1);
  },
};

const pendingLogin = fn(() => new Promise<void>(() => {}));
export const StartingSignIn: Story = {
  decorators: [withAuth({ login: pendingLogin })],
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Log in" }));
    const button = canvas.getByRole("button", { name: "Opening sign-in…" });
    await expect(button).toBeDisabled();
    await expect(canvas.getByRole("status")).toHaveTextContent("Taking you to your sign-in page");
    await userEvent.click(button);
    await expect(pendingLogin).toHaveBeenCalledTimes(1);
  },
};

const failedLogin = fn(async () => { throw new Error("Identity provider unavailable"); });
export const SignInFailure: Story = {
  decorators: [withAuth({ login: failedLogin })],
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Log in" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent("Unable to start sign-in. Please try again.");
    await expect(canvas.getByRole("button", { name: "Log in" })).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "Log in" }));
    await expect(failedLogin).toHaveBeenCalledTimes(2);
  },
};

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
