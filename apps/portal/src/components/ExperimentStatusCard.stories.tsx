// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ExperimentView } from "@/lib/experiments";
import { ExperimentStatusCard } from "./ExperimentStatusCard";

const experiment: ExperimentView = {
  experimentId: "experiment-123",
  projectId: "project-123",
  metadata: { name: "Profile comparison" },
  revision: {
    experimentRevisionId: "revision-1",
    revisionNumber: 1,
    memberCount: 2,
  },
  createdAt: "2026-10-15T00:00:00.000Z",
  createdRequestIds: ["request-1", "request-2"],
  readiness: "processing",
  execution: {
    experimentExecutionId: "execution-1",
    attemptNumber: 2,
    requestCount: 2,
    createdAt: "2026-10-15T00:00:00.000Z",
    requests: [],
    handlerProgress: {
      observations: { status: "done" },
      report: { status: "processing" },
    },
    blocking: [],
  },
  blocking: [],
};

const meta = {
  title: "Experiments/ExperimentStatusCard",
  component: ExperimentStatusCard,
  args: { experiment },
} satisfies Meta<typeof ExperimentStatusCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Processing: Story = {};

export const Blocked: Story = {
  args: {
    experiment: {
      ...experiment,
      readiness: "blocked",
      blocking: [
        {
          handlerId: "observations",
          reason: "dependency-failed",
        },
      ],
    },
  },
};
