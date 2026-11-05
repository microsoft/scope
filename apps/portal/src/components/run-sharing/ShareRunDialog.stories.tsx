// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";
import { http, HttpResponse } from "msw";
import { CreateRunShareSchema } from "shared/run-sharing";
import { ShareRunDialog } from "./ShareRunDialog";
import { exampleShare, exampleToken } from "./fixtures";

const base = "/api/v1/requests/demo-request/runs/demo-attempt/shares";
const handlers = [
  http.get(base, () => HttpResponse.json({ data: [], next: null })),
  http.post(base, async ({ request }) => {
    const input: unknown = await request.json();
    const body = CreateRunShareSchema.parse(input);
    return HttpResponse.json({
      share: { ...exampleShare, label: body.label, content: body.content },
      path: `/shared/runs#${exampleToken}`,
    }, { status: 201 });
  }),
];
const meta = {
  component: ShareRunDialog,
  tags: ["ai-generated", "needs-work"],
  args: {
    requestId: "demo-request", runId: "demo-attempt", attemptNumber: 1,
    open: true, onOpenChange: fn(),
  },
  parameters: { msw: { handlers } },
} satisfies Meta<typeof ShareRunDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Summary: Story = {
  play: async () => {
    await expect(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    await expect(await screen.findByRole("textbox", { name: "Shared URL" })).toHaveValue(expect.stringContaining("/shared/runs#"));
  },
};

export const FullDetailConfirmation: Story = {
  play: async () => {
    await userEvent.click(screen.getByRole("button", { name: "Full detail" }));
    await expect(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
    await expect(screen.getByRole("checkbox", { name: /Source archives/ })).not.toBeChecked();
    await expect(screen.getByRole("checkbox", { name: /Network captures/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: /I have reviewed/ }));
    await expect(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
  },
};

export const ExistingLinks: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(base, () => HttpResponse.json({
          data: [
            exampleShare,
            { ...exampleShare, id: "22222222-2222-4333-8444-555555555555", label: "Expired review", expiresAt: "2000-01-01T00:00:00.000Z" },
            { ...exampleShare, id: "33333333-2222-4333-8444-555555555555", label: "Revoked review", revokedAt: "2026-01-02T00:00:00.000Z" },
          ],
          next: null,
        })),
      ],
    },
  },
};
