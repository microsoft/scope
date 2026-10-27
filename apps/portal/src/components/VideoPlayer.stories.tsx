// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useLayoutEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider, useProjectContext } from "@/contexts/ProjectContext";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { VideoPlayer } from "./VideoPlayer";

const meta = {
  component: VideoPlayer,
  tags: ["ai-generated", "needs-work"],
  args: { src: "/api/v1/requests/example/runs/attempt-1/video", label: "Attempt 1 recording" },
  parameters: {
    docs: { description: { component:
      "Protected playback uses the app's dedicated service worker. Storybook already owns a root MSW worker, " +
      "so the real component must show a conflict rather than replace MSW or use an eager whole-file blob. " +
      "Progressive playback and seeking require the application browser acceptance described in authenticated-media.md.",
    } },
  },
} satisfies Meta<typeof VideoPlayer>;
export default meta;
type Story = StoryObj<typeof meta>;

function SelectedVideo({ project = true }: { project?: boolean }) {
  const { setSelectedProjectId } = useProjectContext();
  const previous = useRef(localStorage.getItem(PROJECT_STORAGE_KEY));
  useLayoutEffect(() => {
    setSelectedProjectId(project ? "demo-project" : undefined);
    return () => {
      if (previous.current === null) localStorage.removeItem(PROJECT_STORAGE_KEY);
      else localStorage.setItem(PROJECT_STORAGE_KEY, previous.current);
    };
  }, [project, setSelectedProjectId]);
  return <VideoPlayer src={meta.args.src} label={meta.args.label} />;
}

function Scenario({ project }: { project?: boolean }) {
  return <AuthContext.Provider value={signedInAuth}>
    <ProjectProvider><SelectedVideo project={project} /></ProjectProvider>
  </AuthContext.Provider>;
}

export const ServiceWorkerConflict: Story = {
  render: () => <Scenario />,
  play: async ({ canvas }) => {
    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent("Another service worker controls this app.");
    await expect(canvas.getByRole("button", { name: "Retry recording" })).toBeVisible();
  },
};

export const RetryConflict: Story = {
  render: () => <Scenario />,
  play: async ({ canvas }) => {
    await canvas.findByRole("alert");
    await userEvent.click(canvas.getByRole("button", { name: "Retry recording" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Another service worker controls this app.");
  },
};

export const AwaitingProject: Story = {
  render: () => <Scenario project={false} />,
  play: async ({ canvas }) => {
    const video = canvas.getByLabelText("Attempt 1 recording");
    await expect(video).not.toHaveAttribute("src");
    await expect(video).toHaveAttribute("preload", "metadata");
  },
};
