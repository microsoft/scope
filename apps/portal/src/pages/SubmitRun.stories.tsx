// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { http, HttpResponse } from "msw";
import { SubmitRun } from "./SubmitRun";

const meta = {
  title: "Pages/Submit Run",
  component: SubmitRun,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get("/api/v1/agents", () =>
          HttpResponse.json([
            {
              _id: "coder-acp-copilot",
              id: "coder-acp-copilot",
              name: "GitHub Copilot CLI",
              defaultModel: "gpt-5.6-sol",
              versions: [],
              capabilities: {},
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ]),
        ),
        http.get("/api/v1/*", () => HttpResponse.json([])),
      ],
    },
  },
} satisfies Meta<typeof SubmitRun>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ExperimentProgressiveDisclosure: Story = {
  args: {
    mode: "experiment",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvas.getByRole("button", { name: /Create empty experiment/ }),
    ).toBeInTheDocument();
    await expect(canvas.queryByLabelText("Tags")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Gate pipeline")).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("switch", { name: "Toggle advanced options" }),
    ).not.toBeInTheDocument();

    await userEvent.type(
      canvas.getByLabelText(/Task/),
      "Implement the benchmark task",
    );

    await expect(
      await canvas.findByText("Gate pipeline"),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("switch", { name: "Toggle advanced options" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", {
        name: /Create experiment with 5 runs/,
      }),
    ).toBeInTheDocument();
  },
};
