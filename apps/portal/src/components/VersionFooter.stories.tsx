// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { VersionFooter } from "./VersionFooter";
import { http, HttpResponse } from "msw";

const meta = {
  component: VersionFooter,
  tags: ["ai-generated", "needs-work"],
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/about", () =>
          HttpResponse.json({ commit: "abc1234def5678", buildTime: "2024-04-01T12:00:00Z" }),
        ),
        http.get("/api/v1/ready", () =>
          HttpResponse.json({
            status: "ready",
            migrations: { ready: true, applied: ["001", "002"], pending: [], totalApplied: 2 },
          }),
        ),
      ],
    },
  },
} satisfies Meta<typeof VersionFooter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/Portal:/)).toBeVisible();
    await expect(
      canvas.getByText(/This is an AI evaluation platform\./),
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Data collection and privacy" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/microsoft/scope/blob/main/website/src/content/docs/resources/data-collection.md",
    );
  },
};

export const ApiUnavailable: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/about", () => HttpResponse.error()),
        http.get("/api/v1/ready", () => HttpResponse.error()),
      ],
    },
  },
};
