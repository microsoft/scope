// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import type { ResourceBindingSpec, ResourceDocument, ResourceRevisionDocument } from "@/types";
import { getSelectedProjectId, setSelectedProjectIdHolder } from "@/lib/project-scope";
import { ResourcePicker } from "./ResourcePicker";

const resource: ResourceDocument = {
  _id: "resource-1",
  projectId: "demo-project",
  slug: "github-simulator",
  name: "GitHub simulator",
  revisionCounter: 1,
  latestRevisionId: "resource-revision-1",
  latestRevisionNumber: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const revision: ResourceRevisionDocument = {
  _id: "resource-revision-1",
  resourceId: resource._id,
  projectId: resource.projectId,
  slug: resource.slug,
  revisionNumber: 1,
  ref: "github-simulator@r1",
  setup: { sh: "echo ready" },
  exports: ["SIMULATOR_URL"],
  parameters: [
    { name: "REPO", required: true, description: "Repository to simulate" },
    { name: "SCENARIO", required: false, default: "default-scenario" },
  ],
  contentSha256: "sha",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function ResourcePickerHarness({
  initial,
  profileBindings = [],
  bindingsLocked = false,
  disabled = false,
}: {
  initial: ResourceBindingSpec[];
  profileBindings?: ResourceBindingSpec[];
  bindingsLocked?: boolean;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState(initial);
  const [scopeReady, setScopeReady] = useState(false);

  useEffect(() => {
    const previousProjectId = getSelectedProjectId();
    setSelectedProjectIdHolder("demo-project");
    setScopeReady(true);
    return () => setSelectedProjectIdHolder(previousProjectId);
  }, []);

  if (!scopeReady) return null;

  return (
    <div className="w-[44rem] max-w-full p-6">
      <ResourcePicker
        selected={selected}
        onChange={setSelected}
        profileBindings={profileBindings}
        bindingsLocked={bindingsLocked}
        disabled={disabled}
      />
    </div>
  );
}

const profileBindings: ResourceBindingSpec[] = [{
  ref: revision.ref,
  params: { REPO: "microsoft/scope" },
}];

const meta = {
  title: "Components/ResourcePicker",
  component: ResourcePicker,
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/v1/resources", () => HttpResponse.json([resource])),
        http.get("*/api/v1/resources/:resourceId/revisions", () => HttpResponse.json([revision])),
      ],
    },
  },
} satisfies Meta<typeof ResourcePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RunOwned: Story = {
  args: {
    selected: [],
    onChange: () => {},
  },
  render: () => <ResourcePickerHarness initial={[]} />,
};

export const ProfileManaged: Story = {
  args: {
    selected: profileBindings,
    profileBindings,
    bindingsLocked: true,
    onChange: () => {},
  },
  render: () => (
    <ResourcePickerHarness
      initial={profileBindings}
      profileBindings={profileBindings}
      bindingsLocked
    />
  ),
};

export const VariationModeLocked: Story = {
  args: {
    selected: profileBindings,
    profileBindings,
    bindingsLocked: true,
    disabled: true,
    onChange: () => {},
  },
  render: () => (
    <ResourcePickerHarness
      initial={profileBindings}
      profileBindings={profileBindings}
      bindingsLocked
      disabled
    />
  ),
};
