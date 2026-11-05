// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { useProjectContext } from "@/contexts/ProjectContext";
import { TurnTimeline } from "./TurnTimeline";

const meta = {
  component: TurnTimeline,
  tags: ["ai-generated", "needs-work"],
  decorators: [function SelectedProject(Story) {
    const { setSelectedProjectId } = useProjectContext();
    useEffect(() => setSelectedProjectId("demo-project"), [setSelectedProjectId]);
    return <Story />;
  }],
  args: {
    runId: "demo",
    attemptRunId: "attempt-1",
    turns: [{
      iteration: 2, timestamp: "2026-01-01T12:00:00Z", passed: true,
      codingAgentResponse: "Implemented the requested behavior.", judgeFeedback: "All checks passed.",
      snapshotUrl: "stored-snapshot", harUrl: "stored-har", atifUrl: "stored-atif",
    }],
  },
  parameters: { msw: { handlers: [
    http.get("*/api/v1/requests/demo/runs/attempt-1/*", () => HttpResponse.json(
      { error: "Artifact is no longer available." }, { status: 404 },
    )),
  ] } },
} satisfies Meta<typeof TurnTimeline>;
export default meta;
type Story = StoryObj<typeof meta>;

export const HistoricalDownloads: Story = {};
export const LegacyLatestDownloads: Story = { args: { attemptRunId: undefined } };
