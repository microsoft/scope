// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { AuthContext, type AuthContextValue } from "@/contexts/AuthContext";
import { anonymousAuth, signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { projectPermissions } from "shared/rbac";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { AccessShell } from "./AccessShell";

afterEach(() => { cleanup(); localStorage.removeItem(PROJECT_STORAGE_KEY); });

function tree(auth: AuthContextValue, path = "/runs", children: ReactNode = <p>Project content</p>) {
  return <AuthContext.Provider value={auth}><ProjectProvider>
    <MemoryRouter initialEntries={[path]}><AccessShell>{children}</AccessShell></MemoryRouter>
  </ProjectProvider></AuthContext.Provider>;
}
const noMembership: AuthContextValue = {
  ...signedInAuth, user: signedInAuth.user && { ...signedInAuth.user,
    capabilities: { platformAdmin: false, reportsEnabled: false, memberships: [] } },
};

it("renders anonymous content without manufacturing capabilities or clearing a selected project", () => {
  localStorage.setItem(PROJECT_STORAGE_KEY, "anonymous-project");
  render(tree(anonymousAuth));
  expect(screen.getByText("Project content")).toBeTruthy();
  expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("anonymous-project");
  expect(screen.queryByText("Access capabilities are unavailable.")).toBeNull();
  expect(screen.queryByRole("link", { name: "Access administration" })).toBeNull();
});
it.each(["/access", "/ACCESS", "/acc%65ss"])("does not expose %s administration when auth is disabled", path => {
  render(tree(anonymousAuth, path));
  expect(screen.getByText("Access administration requires authentication to be enabled.")).toBeTruthy();
  expect(screen.queryByText("Project content")).toBeNull();
});

it("shows only the enrolled account when no memberships exist", () => {
  render(tree(noMembership));
  expect(screen.getByRole("heading", { name: "No project access" })).toBeTruthy();
  expect(screen.queryByText("Project content")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
it("clears a selected project after membership removal", async () => {
  localStorage.setItem(PROJECT_STORAGE_KEY, "demo-project");
  const view = render(tree(signedInAuth));
  expect(screen.getByText("Project content")).toBeTruthy();
  view.rerender(tree(noMembership));
  await waitFor(() => expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull());
  expect(screen.queryByText("Project content")).toBeNull();
});
it("does not allow an ordinary member to open platform administration", () => {
  render(tree(signedInAuth, "/access"));
  expect(screen.getByText("Platform administration is not permitted.")).toBeTruthy();
  expect(screen.queryByText("Project content")).toBeNull();
});
it("allows platform control-plane onboarding without implicit membership", () => {
  const admin = { ...noMembership, user: noMembership.user && { ...noMembership.user,
    capabilities: { platformAdmin: true, reportsEnabled: false as const, memberships: [] } } };
  render(tree(admin, "/access"));
  expect(screen.getByRole("link", { name: "Access administration" })).toBeTruthy();
  expect(screen.getByText("Project content")).toBeTruthy();
});
it.each(["/access", "/ACCESS", "/acc%65ss"])("allows project admins only their exact project membership deep link at %s", path => {
  const auth: AuthContextValue = { ...signedInAuth, user: { ...signedInAuth.user!,
    capabilities: { platformAdmin: false, reportsEnabled: false, memberships: [
      { projectId: "project-a", role: "admin", permissions: projectPermissions("admin"), revision: 1 },
    ] } } };
  for (const suffix of ["", "?projectId=project-b", "?projectId="]) {
    const view = render(tree(auth, `${path}${suffix}`));
    expect(screen.queryByText("Project content")).toBeNull();
    view.unmount();
  }
  render(tree(auth, `${path}?projectId=project-a`));
  expect(screen.getByText("Project content")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Access administration" })).toBeNull();
});
it.each(["reader", "contributor"] as const)("denies membership deep links to a %s", role => {
  const auth: AuthContextValue = { ...signedInAuth, user: { ...signedInAuth.user!,
    capabilities: { platformAdmin: false, reportsEnabled: false, memberships: [
      { projectId: "project-a", role, permissions: projectPermissions(role), revision: 1 },
    ] } } };
  render(tree(auth, "/access?projectId=project-a"));
  expect(screen.queryByText("Project content")).toBeNull();
});

const secretsPaths = [
  "/secrets", "/secrets/keys", "/secrets/keys/new", "/secrets/keys/example",
  "/secrets/keys/example/preview", "/secrets/accounts", "/secrets/accounts/new", "/secrets/accounts/example",
];
const platformPaths = [
  ...secretsPaths, "/agents", "/agents/example", "/models", "/models/example", "/admin", "/admin/settings",
  "/AGENTS", "/ag%65nts", "/agents/EXAMPLE", "/MODELS/example", "/mod%65ls/example",
  "/SECRETS/keys", "/secr%65ts/keys/new", "/ADMIN", "/adm%69n/settings",
];
const platformAdmin: AuthContextValue = {
  ...noMembership, user: noMembership.user && { ...noMembership.user, role: "admin",
    capabilities: { platformAdmin: true, reportsEnabled: false, memberships: [] } },
};

it.each(platformPaths)("allows a platform admin without any project to open %s", path => {
  render(tree(platformAdmin, path));
  expect(screen.getByText("Project content")).toBeTruthy();
  expect(screen.queryByText("Your project role permits reading only.")).toBeNull();
});

it.each(["reader", "contributor", "admin"] as const)("does not grant platform management access to a project %s", role => {
  const member: AuthContextValue = { ...signedInAuth, user: signedInAuth.user && { ...signedInAuth.user,
    capabilities: { ...signedInAuth.user.capabilities, memberships: signedInAuth.user.capabilities.memberships.map(m => ({ ...m, role, permissions: projectPermissions(role) })) } } };
  const ProtectedPage = vi.fn(() => <p>Protected page queried</p>);
  for (const path of platformPaths) {
    const view = render(tree(member, path, <ProtectedPage />));
    expect(screen.getByText("Platform administration is not permitted.")).toBeTruthy();
    expect(ProtectedPage).not.toHaveBeenCalled();
    view.unmount();
  }
});

it.each(platformPaths)("keeps %s global when an admin selects a read-only project", path => {
  localStorage.setItem(PROJECT_STORAGE_KEY, "demo-project");
  const admin: AuthContextValue = { ...platformAdmin, user: platformAdmin.user && { ...platformAdmin.user,
    capabilities: { ...platformAdmin.user.capabilities, memberships: [
      { projectId: "demo-project", role: "reader", permissions: ["content:read"], revision: 1 },
    ] } } };
  render(tree(admin, path));
  expect(screen.getByText("Project content")).toBeTruthy();
});

it.each(platformPaths)("preserves explicit auth-disabled access to %s", path => {
  render(tree(anonymousAuth, path));
  expect(screen.getByText("Project content")).toBeTruthy();
});

it.each(["/agents", "/models", "/secrets/keys"])("blocks %s while capabilities are resolving and after admin removal", path => {
  const view = render(tree(platformAdmin, path));
  expect(screen.getByText("Project content")).toBeTruthy();
  view.rerender(tree({ ...platformAdmin, isReady: false, status: "resolving" }, path));
  expect(screen.queryByText("Project content")).toBeNull();
  expect(screen.getByText("Access capabilities are unavailable.")).toBeTruthy();
  view.rerender(tree(signedInAuth, path));
  expect(screen.queryByText("Project content")).toBeNull();
  expect(screen.getByText("Platform administration is not permitted.")).toBeTruthy();
});

it("still blocks project creation forms without a project content grant", () => {
  render(tree(platformAdmin, "/runs/new"));
  expect(screen.getByText("Your project role permits reading only.")).toBeTruthy();
  expect(screen.queryByText("Project content")).toBeNull();
});
