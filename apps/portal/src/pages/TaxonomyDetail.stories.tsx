// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";
import { HttpResponse, http } from "msw";
import { TaxonomyDetail } from "./TaxonomyDetail";
import type { TaxonomyDetailDocument } from "@/types";

export const taxonomyDetailFixture = {
  taxonomy: {
    _id: "taxonomy-root",
    projectId: "demo-project",
    id: "team-taxonomy",
    name: "Team taxonomy",
    description: "Team-owned taxonomy",
    sourceType: "user",
    revisionCounter: 2,
    latestRevisionId: "taxonomy-revision-2",
    latestRevision: 2,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  selectedRevision: {
    _id: "taxonomy-revision-2",
    taxonomyId: "taxonomy-root",
    projectId: "demo-project",
    id: "team-taxonomy",
    version: "1.2.0",
    sourceType: "user",
    revision: 2,
    ref: "team-taxonomy@r2",
    contentSha256: "2".repeat(64),
    schema_version: "scope/taxonomy/v1",
    surfaces: [],
    elements: [{ ref: "element-b@r1" }, { ref: "element-a@r1" }],
    createdAt: "2026-10-02T00:00:00.000Z",
  },
  revisions: [
    {
      _id: "taxonomy-revision-2",
      revision: 2,
      ref: "team-taxonomy@r2",
      version: "1.2.0",
      elementCount: 2,
      contentSha256: "2".repeat(64),
      createdAt: "2026-10-02T00:00:00.000Z",
      isLatest: true,
    },
    {
      _id: "taxonomy-revision-1",
      revision: 1,
      ref: "team-taxonomy@r1",
      version: "1.0.0",
      elementCount: 1,
      contentSha256: "1".repeat(64),
      createdAt: "2026-10-01T00:00:00.000Z",
      isLatest: false,
    },
  ],
  elements: [
    {
      position: 0,
      root: {
        _id: "element-root-b",
        projectId: "demo-project",
        id: "element-b",
        name: "Element B",
        sourceType: "user",
        revisionCounter: 1,
        latestRevision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      revision: {
        _id: "element-revision-b",
        elementId: "element-root-b",
        projectId: "demo-project",
        id: "element-b",
        label: "Element B",
        description: "Prompt-backed detector",
        sourceType: "user",
        revision: 1,
        ref: "element-b@r1",
        contentSha256: "b".repeat(64),
        implementation: { type: "prompt", prompt: "Original prompt" },
        preconditions: {},
        output: { evidence_roles: {} },
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    },
    {
      position: 1,
      root: {
        _id: "element-root-a",
        projectId: "demo-project",
        id: "element-a",
        name: "Element A",
        sourceType: "builtin",
        revisionCounter: 1,
        latestRevision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      revision: {
        _id: "element-revision-a",
        elementId: "element-root-a",
        projectId: "demo-project",
        id: "element-a",
        label: "Element A",
        sourceType: "builtin",
        revision: 1,
        ref: "element-a@r1",
        contentSha256: "a".repeat(64),
        implementation: {
          type: "deterministic",
          handler: "scope/example-v1",
        },
        preconditions: {},
        output: { evidence_roles: {} },
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    },
  ],
} satisfies TaxonomyDetailDocument;

const meta = {
  component: TaxonomyDetail,
  args: { taxonomyId: "taxonomy-root" },
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get(
          "/api/v1/taxonomies/taxonomy-root/detail",
          () => HttpResponse.json(taxonomyDetailFixture),
        ),
      ],
    },
  },
} satisfies Meta<typeof TaxonomyDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ExactOrderedElements: Story = {
  play: async ({ canvas }) => {
    await expect(
      (await canvas.findAllByText("team-taxonomy@r2"))[0],
    ).toBeVisible();
    await expect(canvas.getAllByText("Prompt")[0]).toBeVisible();
    await expect(canvas.getAllByText("Deterministic")[0]).toBeVisible();
    await expect(canvas.getAllByText("Built-in · read-only")[0]).toBeVisible();
    await userEvent.click(
      canvas.getAllByRole("button", { name: "Edit prompt" })[0],
    );
    await expect(screen.getByLabelText("Prompt instruction")).toHaveValue(
      "Original prompt",
    );
  },
};

export const DeletedHistorical: Story = {
  args: {
    taxonomyId: "taxonomy-root",
    revisionId: "taxonomy-revision-1",
  },
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/v1/taxonomies/taxonomy-root/detail",
          () => HttpResponse.json({
            ...taxonomyDetailFixture,
            taxonomy: {
              ...taxonomyDetailFixture.taxonomy,
              deletedAt: "2026-10-04T00:00:00.000Z",
            },
            selectedRevision: {
              ...taxonomyDetailFixture.selectedRevision,
              _id: "taxonomy-revision-1",
              revision: 1,
              ref: "team-taxonomy@r1",
              elements: [{ ref: "element-b@r1" }],
            },
            elements: [taxonomyDetailFixture.elements[0]],
          }),
        ),
      ],
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Historical")).toBeVisible();
    await expect(canvas.getByText("Deleted")).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Edit prompt" }),
    ).not.toBeInTheDocument();
  },
};
