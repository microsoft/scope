// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { Projects } from "@/pages/Projects";
import { http, HttpResponse } from "msw";
import { AccessShell } from "./AccessShell";

const meta = {
  component: AccessShell,
  tags: ["ai-generated", "needs-work"],
  args: { children: null },
} satisfies Meta<typeof AccessShell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EnrolledWithoutMembership: Story = {
  beforeEach: () => localStorage.removeItem(PROJECT_STORAGE_KEY),
  parameters: { msw: { handlers: [
    http.get("/api/v1/projects", () => HttpResponse.json([])),
  ] } },
  render: () => <AuthContext.Provider value={{
    ...signedInAuth, user: signedInAuth.user && { ...signedInAuth.user,
      capabilities: { platformAdmin: false, reportsEnabled: false, memberships: [] } },
  }}><ProjectProvider><AccessShell><Routes>
    <Route path="/projects" element={<Projects />} />
    <Route path="*" element={<h1>Protected project content</h1>} />
  </Routes></AccessShell></ProjectProvider></AuthContext.Provider>,
  play: async ({ canvas }) => {
    await expect((await canvas.findAllByText("No accessible projects. Ask a project or platform administrator for membership."))[0]).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "Protected project content" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("heading", { name: "No project access" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("link", { name: "Access administration" })).not.toBeInTheDocument();
    for (const button of canvas.getAllByRole("button", { name: "New project" })) {
      await expect(button).toBeDisabled();
    }
  },
};

export const GlobalSecretsWithoutProject: Story = {
  beforeEach: () => localStorage.removeItem(PROJECT_STORAGE_KEY),
  render: () => <AuthContext.Provider value={{
    ...signedInAuth, user: signedInAuth.user && { ...signedInAuth.user, role: "admin",
      capabilities: { platformAdmin: true, reportsEnabled: false, memberships: [] } },
  }}><ProjectProvider><Routes>
    <Route path="/" element={<Navigate to="/secrets/keys/new" replace />} />
    <Route path="/secrets/keys/new" element={<AccessShell><h1>Register global key</h1></AccessShell>} />
  </Routes></ProjectProvider></AuthContext.Provider>,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("heading", { name: "Register global key" })).toBeVisible();
    await expect(canvas.queryByText("Your project role permits reading only.")).not.toBeInTheDocument();
  },
};

export const ProjectContributorCannotManageSecrets: Story = {
  render: () => <AuthContext.Provider value={signedInAuth}><ProjectProvider><Routes>
    <Route path="/" element={<Navigate to="/secrets/accounts/new" replace />} />
    <Route path="/secrets/accounts/new" element={<AccessShell><h1>Register global account</h1></AccessShell>} />
  </Routes></ProjectProvider></AuthContext.Provider>,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Platform administration is not permitted.")).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "Register global account" })).not.toBeInTheDocument();
  },
};

export const GlobalAgentsWithoutProject: Story = {
  beforeEach: () => localStorage.removeItem(PROJECT_STORAGE_KEY),
  render: () => <AuthContext.Provider value={{
    ...signedInAuth, user: signedInAuth.user && { ...signedInAuth.user, role: "admin",
      capabilities: { platformAdmin: true, reportsEnabled: false, memberships: [] } },
  }}><ProjectProvider><Routes>
    <Route path="/" element={<Navigate to="/agents/example" replace />} />
    <Route path="/agents/example" element={<AccessShell><h1>Agent administration</h1></AccessShell>} />
  </Routes></ProjectProvider></AuthContext.Provider>,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("heading", { name: "Agent administration" })).toBeVisible();
  },
};

export const ProjectMemberCannotOpenModels: Story = {
  render: () => <AuthContext.Provider value={signedInAuth}><ProjectProvider><Routes>
    <Route path="/" element={<Navigate to="/models/example" replace />} />
    <Route path="/models/example" element={<AccessShell><h1>Model administration</h1></AccessShell>} />
  </Routes></ProjectProvider></AuthContext.Provider>,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Platform administration is not permitted.")).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "Model administration" })).not.toBeInTheDocument();
  },
};

export const PlatformRoleRemoved: Story = {
  render: () => {
    const [admin, setAdmin] = useState(true);
    return <AuthContext.Provider value={{
      ...signedInAuth, user: signedInAuth.user && { ...signedInAuth.user,
        capabilities: { ...signedInAuth.user.capabilities, platformAdmin: admin } },
    }}><ProjectProvider><Routes>
      <Route path="/" element={<Navigate to="/models/example" replace />} />
      <Route path="/models/example" element={<>
        <button onClick={() => setAdmin(false)}>Remove platform role</button>
        <AccessShell><h1>Model administration</h1></AccessShell>
      </>} />
    </Routes></ProjectProvider></AuthContext.Provider>;
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("heading", { name: "Model administration" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Remove platform role" }));
    await expect(canvas.getByText("Platform administration is not permitted.")).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "Model administration" })).not.toBeInTheDocument();
  },
};
