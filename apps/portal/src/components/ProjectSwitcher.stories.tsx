// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MemoryRouter } from "react-router-dom";
import { expect, userEvent, screen } from "storybook/test";

import { ProjectSwitcherView } from "./ProjectSwitcher";
import type { Project } from "@/types";

const PROJECTS: Project[] = [
  { _id: "p-alpha", id: "p-alpha", name: "Alpha", description: "Primary benchmark project" },
  { _id: "p-bravo", id: "p-bravo", name: "Bravo" },
  { _id: "p-charlie", id: "p-charlie", name: "Charlie" },
] as Project[];

const meta = {
  component: ProjectSwitcherView,
  // Default args satisfy the required props at the meta level; every story
  // overrides `render` with a stateful harness (like CriteriaFilterBar).
  args: {
    projects: PROJECTS,
    activeProjectId: "p-alpha",
    onSelect: () => {},
    onNewProject: () => {},
  },
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof ProjectSwitcherView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Stateful harness so clicking a project moves the active check, like the app. */
function SwitcherHarness({
  projects,
  initialActive,
  isLoading,
}: {
  projects: Project[];
  initialActive?: string;
  isLoading?: boolean;
}) {
  const [active, setActive] = useState<string | undefined>(initialActive);
  const [created, setCreated] = useState(0);
  return (
    <MemoryRouter>
      <div className="flex items-center gap-2">
        <ProjectSwitcherView
          projects={projects}
          activeProjectId={active}
          isLoading={isLoading}
          onSelect={setActive}
          onNewProject={() => setCreated((c) => c + 1)}
        />
        <span data-testid="created-count">{created}</span>
      </div>
    </MemoryRouter>
  );
}

export const Default: Story = {
  render: () => <SwitcherHarness projects={PROJECTS} initialActive="p-alpha" />,
  play: async ({ canvas }) => {
    const trigger = () => canvas.getByRole("button", { name: /switch project/i });
    // Active project shows in the trigger before the menu opens.
    await expect(trigger()).toHaveTextContent("Alpha");
    // Open the dropdown (Radix renders the menu in a portal → query via screen;
    // while open, the modal menu marks the trigger aria-hidden, so we only
    // re-query the trigger after the menu closes below).
    await userEvent.click(trigger());
    const menu = await screen.findByRole("menu");
    await expect(menu).toBeVisible();
    await expect(screen.getByText("Bravo")).toBeVisible();
    // Switching closes the menu and updates the active project label.
    await userEvent.click(screen.getByText("Bravo"));
    const reopened = await canvas.findByRole("button", { name: /switch project/i });
    await expect(reopened).toHaveTextContent("Bravo");
  },
};

export const NoProjectSelected: Story = {
  render: () => <SwitcherHarness projects={PROJECTS} initialActive={undefined} />,
  play: async ({ canvas }) => {
    // With nothing selected the trigger prompts the user to pick a project.
    await expect(
      canvas.getByRole("button", { name: /switch project/i }),
    ).toHaveTextContent(/select project/i);
  },
};

export const Empty: Story = {
  render: () => <SwitcherHarness projects={[]} initialActive={undefined} />,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /switch project/i }));
    await expect(await screen.findByText(/no projects yet/i)).toBeVisible();
    // "New project…" is always offered.
    await expect(screen.getByText(/new project/i)).toBeVisible();
  },
};

export const Loading: Story = {
  render: () => <SwitcherHarness projects={[]} initialActive={undefined} isLoading />,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /switch project/i }));
    await expect(await screen.findByText(/loading/i)).toBeVisible();
  },
};

export const ActiveWhileLoading: Story = {
  // An active project is selected but the list hasn't loaded yet, so it isn't
  // resolvable. The trigger must show "Loading…", never the raw id.
  render: () => <SwitcherHarness projects={[]} initialActive="p-alpha" isLoading />,
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("button", { name: /switch project/i });
    await expect(trigger).toHaveTextContent(/loading/i);
    await expect(trigger).not.toHaveTextContent("p-alpha");
  },
};

export const ActiveNotFound: Story = {
  // The active id has no match once the list has loaded (e.g. the project was
  // deleted in another tab). The trigger shows a soft fallback, not the UUID.
  render: () => <SwitcherHarness projects={PROJECTS} initialActive="p-ghost" />,
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("button", { name: /switch project/i });
    await expect(trigger).toHaveTextContent(/unknown project/i);
    await expect(trigger).not.toHaveTextContent("p-ghost");
  },
};

/** Enough projects to cross the search threshold (#1311). */
const MANY_PROJECTS: Project[] = Array.from({ length: 24 }, (_, i) => ({
  _id: `p-${i}`,
  id: `p-${i}`,
  name: i === 17 ? "Zulu benchmarks" : `Project ${String(i).padStart(2, "0")}`,
})) as Project[];

export const ManyProjects: Story = {
  render: () => <SwitcherHarness projects={MANY_PROJECTS} initialActive="p-0" />,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /switch project/i }));
    const search = await screen.findByRole("textbox", { name: /search projects/i });

    // Typing filters the list instead of jumping between menu items.
    await userEvent.type(search, "zulu");
    await expect(search).toHaveValue("zulu");
    await expect(screen.getByText("Zulu benchmarks")).toBeVisible();
    await expect(screen.queryByText("Project 03")).toBeNull();

    // Picking a filtered result switches the active project.
    await userEvent.click(screen.getByText("Zulu benchmarks"));
    const reopened = await canvas.findByRole("button", { name: /switch project/i });
    await expect(reopened).toHaveTextContent("Zulu benchmarks");
  },
};

export const ManyProjectsNoMatch: Story = {
  render: () => <SwitcherHarness projects={MANY_PROJECTS} initialActive="p-0" />,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /switch project/i }));
    await userEvent.type(await screen.findByRole("textbox", { name: /search projects/i }), "nothing-like-this");
    await expect(screen.getByText(/no matching projects/i)).toBeVisible();
  },
};

export const FewProjectsHaveNoSearch: Story = {
  render: () => <SwitcherHarness projects={PROJECTS} initialActive="p-alpha" />,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /switch project/i }));
    await screen.findByRole("menu");
    await expect(screen.queryByRole("textbox", { name: /search projects/i })).toBeNull();
  },
};
