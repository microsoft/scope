// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { projectPermissions, type ProjectMembershipSummary, type ProjectRole } from "shared/rbac";
import { AuthContext, type AuthContextValue } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider, useProjectContext } from "@/contexts/ProjectContext";
import { api } from "@/lib/api";
import { AccessAdministration } from "./AccessAdministration";

const projectId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const user = { id: userId, role: "user", disabled: false, revision: 0, displayName: "Project administrator" };
const members: ProjectMembershipSummary[] = [{
  _id: `${projectId}:${userId}`, projectId, userId, role: "admin", revision: 1, pending: false, user,
}];
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); localStorage.clear();
  clients.splice(0).forEach(client => client.clear());
});
function auth(role: ProjectRole = "admin", id = userId): AuthContextValue {
  return { ...signedInAuth, user: { ...signedInAuth.user!, id,
    capabilities: { platformAdmin: false, reportsEnabled: false, memberships: [
      { projectId, role, permissions: projectPermissions(role), revision: 1 },
    ] } } };
}
function fixture() {
  vi.spyOn(api, "getProject").mockResolvedValue({ _id: projectId, name: "Project A", createdAt: "2026-01-01T00:00:00Z" });
  vi.spyOn(api, "listProjectMembers").mockResolvedValue(members);
  const scopedDirectory = vi.spyOn(api, "searchProjectMembers").mockResolvedValue({ items: [] });
  const directory = vi.spyOn(api, "searchAccessUsers");
  const inventory = vi.spyOn(api, "listProjects");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  function SwitchProject() {
    const { setSelectedProjectId } = useProjectContext();
    return <button onClick={() => setSelectedProjectId("unrelated-selected-project")}>Switch selected project</button>;
  }
  function tree(value: AuthContextValue) {
    return <QueryClientProvider client={client}><AuthContext.Provider value={value}><ProjectProvider>
      <MemoryRouter initialEntries={[`/access?projectId=${projectId}`]}>
        <SwitchProject /><AccessAdministration />
      </MemoryRouter>
    </ProjectProvider></AuthContext.Provider></QueryClientProvider>;
  }
  return { tree, directory, scopedDirectory, inventory };
}

it("closes an open editor immediately when project-admin authority is removed", async () => {
  const { tree } = fixture();
  const view = render(tree(auth()));
  await waitFor(() => expect(screen.getByRole("button", { name: "Add people" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Add people" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  view.rerender(tree(auth("reader")));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("list", { name: "Project members" })).toBeNull();
  expect(screen.getByText("Project membership administration is not permitted.")).toBeTruthy();
});

it("resets editor state on account changes and never requests global inventory or directory", async () => {
  const { tree, directory, scopedDirectory, inventory } = fixture();
  const view = render(tree(auth()));
  await waitFor(() => expect(screen.getByRole("button", { name: "Add people" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Add people" }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Search users"), { target: { value: "unsubmitted-old-account-text" } });
  expect(scopedDirectory).toHaveBeenCalledWith(projectId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  view.rerender(tree(auth("admin", "new-account")));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(directory).not.toHaveBeenCalled();
  expect(inventory).not.toHaveBeenCalled();
});

it("keeps a membership deep link pinned to its explicit project across selected-project changes", async () => {
  const { tree } = fixture();
  render(tree(auth()));
  await screen.findByText("Project administrator");
  fireEvent.click(screen.getByRole("button", { name: "Switch selected project" }));
  expect(screen.getByText("Project A")).toBeTruthy();
  expect(api.getProject).toHaveBeenCalledWith(projectId);
  expect(api.listProjectMembers).toHaveBeenCalledWith(projectId, expect.any(AbortSignal));
  expect(api.getProject).not.toHaveBeenCalledWith("unrelated-selected-project");
});

it("does not mount project queries while account authority is unavailable", () => {
  const { tree, directory, inventory } = fixture();
  render(tree({ ...auth(), isReady: false, status: "resolving" }));
  expect(api.getProject).not.toHaveBeenCalled();
  expect(api.listProjectMembers).not.toHaveBeenCalled();
  expect(directory).not.toHaveBeenCalled();
  expect(inventory).not.toHaveBeenCalled();
});

it("does not expose project restoration to a project admin even if an authorized in-flight read returns deleted metadata", async () => {
  const { tree } = fixture();
  vi.mocked(api.getProject).mockResolvedValue({
    _id: projectId, name: "Project A", createdAt: "2026-01-01T00:00:00Z", deletedAt: "2026-01-02T00:00:00Z",
  });
  render(tree(auth()));
  await screen.findByText("This project is deleted. Restore it before changing access.");
  expect(screen.queryByRole("button", { name: "Restore project" })).toBeNull();
  expect(screen.getByRole("button", { name: "Add people" }).hasAttribute("disabled")).toBe(true);
});
