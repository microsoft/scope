// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { Link, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { Layout } from "./Layout";

const meta = {
  component: Layout,
  tags: ["ai-generated", "needs-work"],
  decorators: [
    (Story) => (
      <AuthContext.Provider value={signedInAuth}>
        <Story />
      </AuthContext.Provider>
    ),
  ],
  // Layout hides project-scoped nav until a project is in use, so seed one by
  // default; the NoProjectSelected story clears it to show the trimmed sidebar.
  beforeEach: () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, "demo-project");
  },
} satisfies Meta<typeof Layout>;

export default meta;
type Story = StoryObj<typeof meta>;

// Synthetic content isolates the shell's route-dependent spacing from fetching
// individual entities. Each story exercises the list and its nested preview.
function nestedPreviewStory(route: string): Story {
  return {
    parameters: { layout: "fullscreen" },
    render: () => (
      <Routes>
        <Route path="/" element={<Navigate to={route} replace />} />
        <Route element={<Layout />}>
          <Route path={route} element={
            <div className="flex h-full">
              <div className="flex-1 border-r p-4">
                <h1 className="mb-4 text-lg font-semibold">Preview layout example</h1>
                <Link to={`${route}/demo/preview`} className="text-primary underline">Open preview</Link>
              </div>
              <Outlet />
            </div>
          }>
            <Route path=":id/preview" element={
              <aside className="w-80 p-4" aria-label="Entity preview">
                <p className="mb-4">Synthetic preview content</p>
                <Link to={route} className="text-primary underline">Close preview</Link>
              </aside>
            } />
          </Route>
        </Route>
      </Routes>
    ),
    play: async ({ canvas }) => {
      const main = canvas.getByRole("main");
      const listClasses = main.className;
      await expect(listClasses).not.toContain("px-6");
      await userEvent.click(await canvas.findByRole("link", { name: "Open preview" }));
      await expect(canvas.getByRole("complementary", { name: "Entity preview" })).toBeVisible();
      await expect(main.className).toBe(listClasses);
      await userEvent.click(canvas.getByRole("link", { name: "Close preview" }));
      await expect(canvas.queryByRole("complementary", { name: "Entity preview" })).toBeNull();
      await expect(main.className).toBe(listClasses);
    },
  };
}

export const ReportPreview = nestedPreviewStory("/reports");
export const InsightPreview = nestedPreviewStory("/insights");
export const CriterionPreview = nestedPreviewStory("/criteria");
export const TaskPromptPreview = nestedPreviewStory("/task-prompts");
export const McpServerPreview = nestedPreviewStory("/mcp-servers");
export const ExtensionPreview = nestedPreviewStory("/extensions");
export const ProfilePreview = nestedPreviewStory("/profiles");

export const Collapsed: Story = {
  play: async ({ canvas }) => {
    localStorage.removeItem("scope:layout:sidebar-expanded");
    await expect(canvas.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await expect(
      canvas.getByText(/This is an AI evaluation platform\./),
    ).toBeVisible();
  },
};

export const Expanded: Story = {
  play: async ({ canvas }) => {
    localStorage.removeItem("scope:layout:sidebar-expanded");
    await userEvent.click(canvas.getByRole("button", { name: "Expand sidebar" }));
    await expect(canvas.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    // With a project selected, scoped nav is present.
    await expect(canvas.getByRole("link", { name: "Runs" })).toBeVisible();
  },
};

// No project selected: only global entries (Projects + Platform) remain; the
// scoped groups and the New Run CTA are hidden until a project is picked.
export const NoProjectSelected: Story = {
  beforeEach: () => {
    localStorage.removeItem(PROJECT_STORAGE_KEY);
  },
  play: async ({ canvas }) => {
    localStorage.removeItem("scope:layout:sidebar-expanded");
    await userEvent.click(canvas.getByRole("button", { name: "Expand sidebar" }));
    // Global group stays reachable without a selection.
    await expect(canvas.getByText("Platform")).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Agents" })).toBeVisible();
    // Scoped nav and the New Run CTA are gone until a project is selected.
    await expect(canvas.queryByRole("link", { name: "Runs" })).toBeNull();
    await expect(canvas.queryByRole("link", { name: "New Run" })).toBeNull();
  },
};
