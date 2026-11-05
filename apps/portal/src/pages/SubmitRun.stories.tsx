// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { http, HttpResponse } from "msw";
import { expect, userEvent } from "storybook/test";
import { useProjectContext } from "@/contexts/ProjectContext";
import { SubmitRun } from "./SubmitRun";

function InDemoProject({ children }: { children: React.ReactNode }) {
  const { selectedProjectId, setSelectedProjectId } = useProjectContext();
  useEffect(() => setSelectedProjectId("demo-project"), [setSelectedProjectId]);
  return selectedProjectId === "demo-project" ? children : null;
}

const profileVersion = {
  _id: "profile-version-1",
  profileId: "profile-1",
  version: 1,
  workerType: "coder-acp-copilot",
  model: "gpt-5.6-sol",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const meta = {
  title: "pages/SubmitRun",
  component: SubmitRun,
  decorators: [
    (Story) => <InDemoProject><Story /></InDemoProject>,
  ],
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/agents", () => HttpResponse.json([{
          _id: "coder-acp-copilot",
          name: "GitHub Copilot CLI",
          supportedModels: ["gpt-5.6-sol"],
          available: true,
          versions: [{ agentVersion: "1.0.0", status: "active", queueName: "queue-copilot" }],
          createdAt: "2026-01-01T00:00:00.000Z",
        }])),
        http.get("/api/v1/profiles", () => HttpResponse.json([{
          _id: "profile-1",
          name: "Base profile",
          latestVersion: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          version: profileVersion,
        }])),
        http.get("/api/v1/profiles/profile-1/versions", () => HttpResponse.json([profileVersion])),
      ],
    },
  },
} satisfies Meta<typeof SubmitRun>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Profile composition uses the selected base and variation rows without a graph. */
export const ProfileVariations: Story = {
  play: async ({ canvas }) => {
    const picker = await canvas.findByPlaceholderText("Search existing profiles…");
    await userEvent.click(picker);
    await userEvent.click(await canvas.findByRole("listitem", { name: /Base profile/ }));
    await expect(canvas.getByText("Variations")).toBeVisible();
    await expect(canvas.queryByLabelText("Profile composition graph")).not.toBeInTheDocument();
  },
};
