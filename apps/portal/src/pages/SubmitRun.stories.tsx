// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, userEvent } from "storybook/test";

import { useProjectContext } from "@/contexts/ProjectContext";
import type { CodingAgent, ProfileWithVersion } from "@/types";
import { SubmitRun } from "./SubmitRun";

const agent: CodingAgent = {
  _id: "coder-acp-copilot",
  name: "GitHub Copilot CLI",
  supportedModels: ["gpt-5.6-sol"],
  defaultModel: "gpt-5.6-sol",
  available: true,
  versions: [{
    agentVersion: "1.0.0",
    workerVersion: "1.0.0",
    components: {},
    gitCommit: "abc123",
    buildTime: "2026-01-01T00:00:00.000Z",
    imageTag: "demo",
    queueName: "queue-coder-acp-copilot",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  }],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const profiles: ProfileWithVersion[] = ["Baseline", "Variation One", "Variation Two"].map((name, index) => ({
  _id: `profile-${index + 1}`,
  name,
  latestVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  version: {
    _id: `version-${index + 1}`,
    profileId: `profile-${index + 1}`,
    version: 1,
    workerType: agent._id,
    model: "gpt-5.6-sol",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
}));

function WithDemoProject({ children }: { children: ReactNode }) {
  const { selectedProjectId, setSelectedProjectId } = useProjectContext();
  useEffect(() => setSelectedProjectId("demo-project"), [setSelectedProjectId]);
  return selectedProjectId === "demo-project" ? children : null;
}

const meta = {
  component: SubmitRun,
  decorators: [(Story) => <WithDemoProject><Story /></WithDemoProject>],
  parameters: {
    msw: { handlers: [
      http.get("*/api/v1/agents", () => HttpResponse.json([agent])),
      http.get("*/api/v1/profiles", () => HttpResponse.json(profiles)),
      http.get("*/api/v1/profiles/:profileId/versions", ({ params }) =>
        HttpResponse.json(profiles.filter((profile) => profile._id === params.profileId).map((profile) => profile.version))),
      http.get("*/api/v1/models", () => HttpResponse.json([{ modelId: "gpt-5.6-sol" }])),
      http.get("*/api/v1/mcp/servers", () => HttpResponse.json([])),
      http.get("*/api/v1/requests", () => HttpResponse.json({ data: [] })),
      http.get("*/api/v1/version", () => HttpResponse.json({ commit: "demo", buildTime: "2026-01-01T00:00:00.000Z" })),
    ] },
  },
} satisfies Meta<typeof SubmitRun>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SearchVariations: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByPlaceholderText("Search existing profiles…"));
    await userEvent.click(canvas.getByText("Baseline", { selector: "li p" }));
    await userEvent.click(canvas.getByRole("button", { name: /Add after Baseline/ }));

    const variationPicker = canvas.getByPlaceholderText("Variation One");
    await userEvent.type(variationPicker, "Variation Two");
    await userEvent.click(canvas.getByText("Variation Two", { selector: "li p" }));

    await expect(canvas.getByPlaceholderText("Variation Two")).toBeVisible();
  },
};
