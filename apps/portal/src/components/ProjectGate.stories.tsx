// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { ProjectFirstRunView, ProjectGate } from "./ProjectGate";
import { ProjectProvider, useSelectedProjectId } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import type { Project } from "@/types";

const PROJECTS: Project[] = [
  { _id: "p-alpha", id: "p-alpha", name: "Alpha", description: "Primary benchmark project" },
  { _id: "p-bravo", id: "p-bravo", name: "Bravo" },
] as Project[];

// A stand-in for the real <ProjectCreateForm> (which owns a mutation); the view
// only renders it as an opaque slot, so a stub keeps the story pure.
const CreateSlot = <Button type="button">Create &amp; open</Button>;

const meta = {
  component: ProjectFirstRunView,
  args: {
    projects: PROJECTS,
    onSelect: () => {},
    createSlot: CreateSlot,
  },
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof ProjectFirstRunView>;

export default meta;
type Story = StoryObj<typeof meta>;

function FirstRunHarness({ projects, isLoading }: { projects: Project[]; isLoading?: boolean }) {
  const [selected, setSelected] = useState<string | undefined>();
  return (
    <div>
      <ProjectFirstRunView
        projects={projects}
        isLoading={isLoading}
        onSelect={setSelected}
        createSlot={CreateSlot}
      />
      <span data-testid="selected">{selected ?? ""}</span>
    </div>
  );
}

export const WithProjects: Story = {
  render: () => <FirstRunHarness projects={PROJECTS} />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: /select a project/i })).toBeVisible();
    // Picking an existing project reports it upward.
    await userEvent.click(canvas.getByRole("button", { name: /alpha/i }));
    await expect(canvas.getByTestId("selected")).toHaveTextContent("p-alpha");
  },
};

export const FirstRunEmpty: Story = {
  render: () => <FirstRunHarness projects={[]} />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: /select a project/i })).toBeVisible();
    // No project list card, but the create-your-first affordance is shown.
    await expect(canvas.getByText(/create your first project/i)).toBeVisible();
  },
};

export const Loading: Story = {
  render: () => <FirstRunHarness projects={[]} isLoading />,
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/loading projects/i)).toBeVisible();
  },
};

function SharedProjectContent() {
  const selectedProjectId = useSelectedProjectId();
  return <p>Shared results project: {selectedProjectId}</p>;
}

function SharedProjectRoute() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    navigate("?projectId=p-bravo&submissionId=submission-example&groupBy=profile", { replace: true });
    setReady(true);
  }, [navigate]);
  return ready ? <ProjectGate><SharedProjectContent /></ProjectGate> : null;
}

function SharedProjectHarness() {
  const [client] = useState(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    queryClient.setQueryData(["projects"], PROJECTS);
    return queryClient;
  });
  return (
    <QueryClientProvider client={client}>
      <ProjectProvider><SharedProjectRoute /></ProjectProvider>
    </QueryClientProvider>
  );
}

export const SharedProject: Story = {
  render: () => <SharedProjectHarness />,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Shared results project: p-bravo")).toBeVisible();
  },
};
