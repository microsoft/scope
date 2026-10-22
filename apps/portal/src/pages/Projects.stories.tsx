// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, userEvent, screen } from "storybook/test";
import { AuthContext, type AuthContextValue } from "@/contexts/AuthContext";
import { anonymousAuth, signedInAuth } from "@/contexts/authFixtures";
import { Projects } from "./Projects";

const project = {
  _id: "demo-project", id: "demo-project", name: "Newly created project",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", revision: 1,
};
const adminAuth: AuthContextValue = {
  ...signedInAuth,
  user: {
    ...signedInAuth.user!,
    role: "admin" as const,
    capabilities: { platformAdmin: true, reportsEnabled: false, memberships: [] },
  },
};
const readerAuth: AuthContextValue = {
  ...signedInAuth,
  user: {
    ...signedInAuth.user!,
    capabilities: {
      platformAdmin: false, reportsEnabled: false,
      memberships: [{ projectId: project._id, role: "reader" as const, permissions: ["content:read" as const], revision: 1 }],
    },
  },
};
const creatorAuth: AuthContextValue = {
  ...adminAuth,
  user: {
    ...adminAuth.user!,
    capabilities: {
      platformAdmin: true, reportsEnabled: false,
      memberships: [{
        projectId: project._id, role: "admin",
        permissions: ["content:read", "content:write", "content:delete", "settings:write", "members:write"], revision: 1,
      }],
    },
  },
};
const projectAdminAuth: AuthContextValue = {
  ...creatorAuth, user: { ...creatorAuth.user!, role: "user",
    capabilities: { ...creatorAuth.user!.capabilities, platformAdmin: false } },
};
const meta = {
  component: Projects,
  tags: ["ai-generated", "needs-work"],
  decorators: [(Story, context) => <AuthContext.Provider value={context.parameters.anonymous ? anonymousAuth : context.parameters.reader ? readerAuth : context.parameters.projectAdmin ? projectAdminAuth : context.parameters.creator ? creatorAuth : adminAuth}><Story /></AuthContext.Provider>],
  parameters: { msw: { handlers: [
    http.get("/api/v1/projects", ({ request }) => HttpResponse.json(
      new URL(request.url).searchParams.get("controlPlane") === "true" ? [project] : [],
    )),
  ] } },
} satisfies Meta<typeof Projects>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AuthenticationDisabled: Story = {
  parameters: { anonymous: true, msw: { handlers: [
    http.get("/api/v1/projects", ({ request }) => HttpResponse.json(
      new URL(request.url).searchParams.has("includeDeleted")
        ? [project, { ...project, _id: "deleted", id: "deleted", name: "Deleted fixture", deletedAt: "2026-01-02T00:00:00Z" }]
        : [project],
    )),
  ] } },
  play: async ({ canvas }) => {
    await expect((await canvas.findAllByRole("button", { name: "Use project" }))[0]).toBeEnabled();
    await expect(canvas.getAllByRole("button", { name: `Edit ${project.name}` })[0]).toBeEnabled();
    await expect(canvas.getAllByRole("button", { name: `Delete ${project.name}` })[0]).toBeEnabled();
    await expect(canvas.queryByRole("link", { name: "Access administration" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Show deleted" }));
    await expect((await canvas.findAllByRole("button", { name: "Restore" }))[0]).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "New project" }));
    await expect(await screen.findByRole("dialog")).toBeVisible();
    await expect(screen.queryByText(/New projects grant their creator/)).not.toBeInTheDocument();
  },
};

export const AdministratorWithoutMembership: Story = {
  play: async ({ canvas }) => {
    await expect((await canvas.findAllByText(/No accessible projects/))[0]).toBeVisible();
    await expect(canvas.queryByText(project.name)).not.toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: "Access administration" })).toHaveAttribute("href", "/access");
    await expect(canvas.queryByRole("button", { name: "Use project" })).not.toBeInTheDocument();
    await expect(canvas.queryByText(/Only projects with content access appear here/)).not.toBeInTheDocument();
    await expect(canvas.queryByText("Projects you can access, with runs, profiles, criteria, and more.")).not.toBeInTheDocument();
  },
};

export const ReaderWithMembership: Story = {
  parameters: { reader: true, msw: { handlers: [
    http.get("/api/v1/projects", ({ request }) => HttpResponse.json(
      new URL(request.url).searchParams.get("controlPlane") !== "true" ? [project] : [],
    )),
  ] } },
  play: async ({ canvas }) => {
    await expect((await canvas.findAllByRole("button", { name: "Use project" }))[0]).toBeEnabled();
    await expect(canvas.getAllByRole("button", { name: `Edit ${project.name}` })[0]).toBeDisabled();
    await expect(canvas.getAllByRole("button", { name: `Delete ${project.name}` })[0]).toBeDisabled();
    await expect(canvas.queryByRole("link", { name: "Manage access" })).not.toBeInTheDocument();
  },
};

export const CreatorProjectAdmin: Story = {
  parameters: { creator: true, msw: { handlers: [
    http.get("/api/v1/projects", ({ request }) => {
      if (new URL(request.url).searchParams.has("controlPlane")) return HttpResponse.json({ error: "Content inventory must not use control plane" }, { status: 400 });
      return HttpResponse.json([project, { ...project, _id: "foreign-project", id: "foreign-project", name: "Unjoined project" }]);
    }),
  ] } },
  play: async ({ canvas }) => {
    await expect((await canvas.findAllByRole("button", { name: "Use project" }))[0]).toBeEnabled();
    await expect(canvas.getAllByRole("button", { name: `Edit ${project.name}` })[0]).toBeEnabled();
    await expect(canvas.getAllByRole("button", { name: `Delete ${project.name}` })[0]).toBeEnabled();
    await expect(canvas.getAllByRole("link", { name: "Manage access" })[0]).toHaveAttribute("href", `/access?projectId=${project._id}`);
    await expect(canvas.queryByText("Unjoined project")).not.toBeInTheDocument();
  },
};

export const ProjectAdminMembershipEntry: Story = {
  parameters: { projectAdmin: true, msw: { handlers: [
    http.get("/api/v1/projects", () => HttpResponse.json([project])),
  ] } },
  play: async ({ canvas }) => {
    await expect((await canvas.findAllByRole("link", { name: "Manage access" }))[0]).toHaveAttribute("href", `/access?projectId=${project._id}`);
    await expect(canvas.queryByRole("link", { name: "Access administration" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "New project" })).toBeDisabled();
    await expect(canvas.getAllByRole("button", { name: `Edit ${project.name}` })[0]).toBeEnabled();
    await expect(canvas.getAllByRole("button", { name: `Delete ${project.name}` })[0]).toBeDisabled();
  },
};

export const InventoryUnavailable: Story = {
  parameters: { msw: { handlers: [
    http.get("/api/v1/projects", () => HttpResponse.json({ error: "Authority unavailable" }, { status: 503 })),
  ] } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Project inventory unavailable");
    await expect(canvas.queryByText(/No projects yet/)).not.toBeInTheDocument();
  },
};
