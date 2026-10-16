// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { SubmissionStatusCard } from "./SubmissionStatusCard";
import type { Submission } from "@/types";

const submission: Submission = {
  submissionId: "submission-123",
  projectId: "project-123",
  requestIds: ["request-1", "request-2"],
  createdAt: new Date().toISOString(),
  submissionRunId: "submission-run-1",
  attemptNumber: 2,
  readiness: "processing",
  requests: [
    {
      requestId: "request-1",
      runId: "run-1",
      task: "Implement the feature",
      status: "done",
      outcome: "succeeded",
      workerType: "coder-acp-copilot",
    },
    {
      requestId: "request-2",
      runId: "run-2",
      task: "Implement the feature",
      status: "done",
      outcome: "failed",
      workerType: "coder-acp-copilot",
    },
  ],
  dependencyProjection: [
    {
      requestId: "request-1",
      runId: "run-1",
      handlerId: "pp-observations",
      state: "ready",
    },
    {
      requestId: "request-2",
      runId: "run-2",
      handlerId: "security-scan",
      state: "ready",
    },
  ],
  blocking: [],
  handlerProgress: {
    "pp-readout": { status: "processing", version: 1 },
  },
};
const meta = {
  title: "Submissions/SubmissionStatusCard",
  component: SubmissionStatusCard,
  args: { submission },
} satisfies Meta<typeof SubmissionStatusCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GeneratingReport: Story = {};

export const Retryable: Story = {
  args: {
    submission: {
      ...submission,
      readiness: "ready",
      handlerProgress: {
        "pp-readout": { status: "failed", version: 1, error: "Model timeout" },
      },
    },
  },
};

export const ReportReady: Story = {
  args: {
    submission: {
      ...submission,
      readiness: "done",
      report: { reportId: "report-123" },
      handlerProgress: {
        "pp-readout": { status: "done", version: 1 },
      },
    },
  },
};

export const Blocked: Story = {
  args: {
    submission: {
      ...submission,
      readiness: "blocked",
      blocking: [
        {
          requestId: "request-2",
          runId: "run-2",
          handlerId: "security-scan",
          reason: "dependency-failed",
        },
      ],
    },
  },
};
