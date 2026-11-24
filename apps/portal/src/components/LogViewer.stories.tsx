// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { LogViewer } from "./LogViewer";
import type { LogEvent } from "@/types";

const base = new Date("2026-06-21T12:00:00Z").getTime();

function log(
  offsetSec: number,
  level: LogEvent["level"],
  message: string,
  data?: Record<string, unknown>,
  source?: string
): LogEvent {
  return {
    timestamp: new Date(base + offsetSec * 1000).toISOString(),
    level,
    message,
    source,
    data,
  };
}

const longLine =
  "Spawning agent process: node --max-old-space-size=4096 /workspace/apps/workers/coder-acp-copilot/dist/index.js --task-id 9f3c1a2b-44de-4c7e-8b21-aa0099887766 --queue queue-coder-acp-copilot --blob-container iteration-snapshots --very-long-flag-that-extends-well-beyond-the-visible-viewport-to-demonstrate-horizontal-scrolling";

const sampleLogs: LogEvent[] = [
  log(0, "info", "Run accepted", { phase: "setup" }, "api"),
  log(1, "info", "Cloning repository", undefined, "worker"),
  log(2, "debug", longLine, { pid: 48213, cwd: "/workspace" }, "worker"),
  log(3, "info", "Starting iteration", { iteration: 1, gate: "implement" }, "worker"),
  log(4, "info", "Agent: created src/index.ts", { iteration: 1, gate: "implement" }, "agent"),
  log(5, "warn", "Lint warning: unused variable 'tmp'", { iteration: 1, gate: "implement" }, "agent"),
  log(6, "info", "Starting iteration", { iteration: 2, gate: "verify" }, "worker"),
  log(7, "error", "Test failed: expected 200 but received 500 for GET /health — see full stack trace in attached data for the complete failure details", { iteration: 2, gate: "verify", attempts: 3 }, "judge"),
];

const meta: Meta<typeof LogViewer> = {
  title: "components/LogViewer",
  component: LogViewer,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof LogViewer>;

/** Live stream: connected, auto-scroll-to-bottom indicator is active. */
export const StreamingLive: Story = {
  args: {
    runId: "demo-run",
    logs: sampleLogs,
    isConnected: true,
    isDone: false,
    error: null,
  },
};

/** Stored JSON events for a completed run; no SSE connection is needed. */
export const CompletedRun: Story = {
  args: {
    runId: "demo-run",
    logs: sampleLogs,
    isConnected: false,
    isDone: true,
    error: null,
  },
};

/** Empty state before any events arrive. */
export const Empty: Story = {
  args: {
    runId: "demo-run",
    logs: [],
    isConnected: false,
    isDone: false,
    error: null,
  },
};
