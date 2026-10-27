// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, type within } from "storybook/test";
import { useProjectContext } from "@/contexts/ProjectContext";
import { ConversationView } from "./ConversationView";

const meta = {
  component: ConversationView,
  tags: ["ai-generated", "needs-work"],
  decorators: [function SelectedProject(Story) {
    const { setSelectedProjectId } = useProjectContext();
    useEffect(() => setSelectedProjectId("demo-project"), [setSelectedProjectId]);
    return <Story />;
  }],
  args: {
    runId: "demo", attemptRunId: "attempt-1",
    turns: [{
      iteration: 1, timestamp: "2026-01-01T12:00:00Z", passed: true,
      codingAgentResponse: "The stored response remains available.", judgeFeedback: "Passed.",
      snapshotUrl: "", harUrl: "stored-har",
    }],
  },
} satisfies Meta<typeof ConversationView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const HarAccessDenied = {
  parameters: { msw: { handlers: [
    http.get("*/api/v1/requests/demo/runs/attempt-1/har", () => HttpResponse.json(
      { error: "Project access was removed." }, { status: 403 },
    )),
  ] } },
  play: async ({ canvas }: { canvas: ReturnType<typeof within> }) => {
    await expect(await canvas.findByRole("alert")).toHaveTextContent("HTTP 403");
    await expect(canvas.getByText("The stored response remains available.")).toBeVisible();
  },
} satisfies Story;
