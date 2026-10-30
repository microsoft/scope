// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor } from "storybook/test";
import { HttpResponse, http } from "msw";
import { TaxonomyList } from "./TaxonomyList";
import type { TaxonomyListItem } from "@/types";

export const taxonomyListFixtures = [
  {
    _id: "builtin-root",
    projectId: "demo-project",
    id: "ax-taxonomy",
    name: "Ax taxonomy",
    description: "Canonical agent behavior taxonomy",
    sourceType: "builtin",
    revisionCounter: 1,
    latestRevisionId: "builtin-revision",
    latestRevision: 1,
    ref: "ax-taxonomy@r1",
    version: "1.0.0",
    elementCount: 6,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  {
    _id: "user-root",
    projectId: "demo-project",
    id: "team-taxonomy",
    name: "Team taxonomy",
    sourceType: "user",
    revisionCounter: 2,
    latestRevisionId: "user-revision",
    latestRevision: 2,
    ref: "team-taxonomy@r2",
    version: "1.2.0",
    elementCount: 3,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  },
] satisfies TaxonomyListItem[];

const meta = {
  component: TaxonomyList,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get(
          "/api/v1/taxonomies",
          () => HttpResponse.json(taxonomyListFixtures),
        ),
      ],
    },
  },
  decorators: [
    Story => (
      <div className="h-[760px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaxonomyList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TableInteractions: Story = {
  play: async ({ canvas }) => {
    await expect((await canvas.findAllByText("Ax taxonomy"))[0]).toBeVisible();
    await expect(canvas.getAllByText("ax-taxonomy@r1")[0]).toBeVisible();
    await expect(canvas.getAllByText("Built-in · read-only")[0]).toBeVisible();

    fireEvent.change(canvas.getByPlaceholderText("Search taxonomies…"), {
      target: { value: "Team" },
    });
    await waitFor(() => {
      expect(canvas.queryAllByText("Ax taxonomy")).toHaveLength(0);
    });
    await expect(canvas.getAllByText("Team taxonomy")[0]).toBeVisible();

    await userEvent.click(
      canvas.getByRole("button", { name: "Customize Columns" }),
    );
    await expect(
      canvas.getByRole("complementary", { name: "Customize columns" }),
    ).toBeVisible();
  },
};

export const EmptyState: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/v1/taxonomies", () => HttpResponse.json([])),
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(
      (await canvas.findAllByText(
        "No taxonomies yet. Create one or copy the built-in catalog.",
      ))[0],
    ).toBeVisible();
  },
};
