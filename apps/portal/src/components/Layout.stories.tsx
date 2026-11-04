// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Navigate, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { Layout } from "./Layout";
import { TokenList } from "@/pages/TokenList";
import { TokenPreviewPanel } from "@/pages/TokenPreviewPanel";
import type { KeyDocument } from "@/types";
import { mswHandlers } from "../../.storybook/msw-handlers";

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

export const Collapsed: Story = {
  play: async ({ canvas }) => {
    localStorage.removeItem("scope:layout:sidebar-expanded");
    await expect(canvas.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    const newRun = canvas.getByRole("link", { name: "New Run" });
    const body = within(document.body);
    await userEvent.hover(newRun);
    let tray = body.getByRole("group", { name: "New workflow choices" });
    await expect(tray).toBeVisible();
    await expect(tray.getBoundingClientRect().left).toBe(
      newRun.getBoundingClientRect().left,
    );
    await expect(tray.getBoundingClientRect().top).toBe(
      newRun.getBoundingClientRect().top,
    );
    await expect(tray.getBoundingClientRect().height).toBe(
      newRun.getBoundingClientRect().height,
    );
    await expect(tray.getBoundingClientRect().width).toBeGreaterThan(
      newRun.getBoundingClientRect().width,
    );
    await expect(tray.className).toContain("transition-[width]");
    await expect(tray.className).toContain("origin-left");
    const expandedPlus = within(tray).getByTestId("expanded-workflow-plus-tile");
    const runLabel = within(tray).getByTestId("expanded-workflow-run-label");
    await expect(expandedPlus.getBoundingClientRect()).toEqual(
      newRun.getBoundingClientRect(),
    );
    await expect(runLabel.getBoundingClientRect().left).toBe(
      newRun.getBoundingClientRect().right,
    );
    await expect(tray.getBoundingClientRect().right).toBeLessThanOrEqual(
      window.innerWidth,
    );
    await expect(
      within(tray).getByRole("link", { name: "New Run" }),
    ).toHaveAttribute("href", "/runs/new");
    await expect(
      within(tray).getByRole("link", { name: "New Experiment" }),
    ).toHaveAttribute("href", "/experiments/new");

    await userEvent.unhover(newRun);
    await waitFor(() =>
      expect(
        body.queryByRole("group", { name: "New workflow choices" }),
      ).toBeNull(),
    );

    newRun.focus();
    tray = body.getByRole("group", { name: "New workflow choices" });
    await expect(tray).toBeVisible();
    await userEvent.tab();
    await expect(within(tray).getByRole("link", { name: "New Run" })).toHaveFocus();
    await userEvent.tab();
    await expect(
      within(tray).getByRole("link", { name: "New Experiment" }),
    ).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(
      body.queryByRole("group", { name: "New workflow choices" }),
    ).toBeNull();
    await expect(newRun).toHaveFocus();
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
    await expect(
      canvas.getByRole("link", { name: "New Experiment" }),
    ).toBeVisible();
    // With a project selected, scoped nav is present.
    await expect(canvas.getByRole("link", { name: "Runs" })).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "Taxonomies" })).toBeNull();
    const experimentsLink = canvas.getByRole("link", { name: "Experiments" });
    const runsLink = canvas.getByRole("link", { name: "Runs" });
    const criteriaLink = canvas.getByRole("link", { name: "Criteria" });
    await expect(experimentsLink.querySelector(".lucide-atom")).not.toBeNull();
    await expect(
      criteriaLink.querySelector(".lucide-flask-conical"),
    ).not.toBeNull();
    await expect(experimentsLink.nextElementSibling).toBe(runsLink);
  },
};

export const TaxonomeEnabled: Story = {
  parameters: {
    msw: {
      handlers: [
        ...mswHandlers,
        http.get("/api/v1/feature-flags", () =>
          HttpResponse.json([
            {
              key: "taxonome",
              label: "Taxonome and Taxonomies",
              enabled: true,
              updatedAt: "2026-10-28T00:00:00.000Z",
            },
          ]),
        ),
      ],
    },
  },
  play: async ({ canvas }) => {
    localStorage.setItem("scope:layout:sidebar-expanded", "true");
    await expect(
      await canvas.findByRole("link", { name: "Taxonomies" }),
    ).toHaveAttribute("href", "/taxonomies");
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

const previewKeys: KeyDocument[] = Array.from({ length: 7 }, (_, index) => ({
  _id: `00000000000000000000000${index}`,
  type: "github-pat-fine-grained",
  capabilities: ["github-public-api"],
  secretName: `synthetic-key-${index}`,
  lastValidationStatus: "valid",
  enabled: true,
  comment: `Demo key ${index + 1}`,
  acquireCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
}));

export const KeyPreview: Story = {
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        ...mswHandlers,
        http.get("/api/v1/keys", () => HttpResponse.json(previewKeys)),
        http.get("/api/v1/keys/:id", ({ params }) =>
          HttpResponse.json(previewKeys.find((key) => key._id === params.id)),
        ),
      ],
    },
  },
  render: () => (
    <Routes>
      <Route path="/" element={<Navigate to="/secrets/keys" replace />} />
      <Route element={<Layout />}>
        <Route path="/secrets/keys" element={<TokenList />}>
          <Route path=":id/preview" element={<TokenPreviewPanel />} />
        </Route>
      </Route>
    </Routes>
  ),
  play: async ({ canvas }) => {
    const main = canvas.getByRole("main");
    const listClasses = main.className;

    await userEvent.click(await canvas.findByRole("cell", { name: "Demo key 1" }));
    await expect(await canvas.findByRole("link", { name: "Open full view" })).toBeVisible();
    await expect(main.className).toBe(listClasses);

    await userEvent.click(canvas.getByRole("button", { name: "Close detail panel" }));
    await expect(canvas.queryByRole("link", { name: "Open full view" })).toBeNull();
    await expect(main.className).toBe(listClasses);
  },
};
