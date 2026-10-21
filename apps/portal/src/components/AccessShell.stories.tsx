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
import { AccessShell, NoAccessView } from "./AccessShell";

const meta = {
  component: NoAccessView,
  tags: ["ai-generated", "needs-work"],
  args: { userId: "11111111-2222-4333-8444-555555555555", onLogout: () => {} },
} satisfies Meta<typeof NoAccessView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EnrolledWithoutMembership: Story = {
  render: args => {
    const [signedOut, setSignedOut] = useState(false);
    return signedOut ? <p>Signed out</p> : <NoAccessView {...args} onLogout={() => setSignedOut(true)} />;
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "No project access" })).toBeVisible();
    await expect(canvas.getByText(meta.args.userId)).toBeVisible();
    await expect(canvas.queryByRole("link")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Sign out" }));
    await expect(canvas.getByText("Signed out")).toBeVisible();
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
