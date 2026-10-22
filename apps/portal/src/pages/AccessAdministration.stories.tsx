// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { Link, useLocation } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { projectPermissions } from "shared/rbac";
import type { AccessUserSummary, ProjectMembershipSummary, ProjectRole } from "shared/rbac";
import { AccessAdministration } from "./AccessAdministration";

const projectId = "11111111-1111-4111-8111-111111111111";
const alice: AccessUserSummary = { id: "22222222-2222-4222-8222-222222222222", displayName: "Alice Example", email: "alice@example.test", role: "admin", disabled: false, revision: 1 };
const bob: AccessUserSummary = { id: "33333333-3333-4333-8333-333333333333", displayName: "Bob Example", email: "bob@example.test", role: "user", disabled: false, revision: 1 };
const charlie: AccessUserSummary = { id: "44444444-4444-4444-8444-444444444444", displayName: "Charlie Example", email: "charlie@example.test", role: "user", disabled: false, revision: 1 };
const disabled: AccessUserSummary = { ...charlie, id: "55555555-5555-4555-8555-555555555555", displayName: "Disabled user", disabled: true };
const project = { _id: projectId, name: "Scope benchmarks", revision: 1, createdAt: "2026-01-01T00:00:00Z" };
const platformAuth: AuthContextValue = { ...signedInAuth, user: { ...signedInAuth.user!,
  id: alice.id, capabilities: { platformAdmin: true, reportsEnabled: false, memberships: [] } } };
const projectAdminAuth: AuthContextValue = { ...signedInAuth, user: { ...signedInAuth.user!, id: alice.id,
  capabilities: { platformAdmin: false, reportsEnabled: false, memberships: [
    { projectId, role: "admin", permissions: projectPermissions("admin"), revision: 1 },
  ] } } };
function member(user: AccessUserSummary, role: ProjectRole, extra: Partial<ProjectMembershipSummary> = {}): ProjectMembershipSummary {
  return { _id: `${projectId}:${user.id}`, projectId, userId: user.id, role, revision: 1, pending: false, user, ...extra };
}
function handlers(initial: ProjectMembershipSummary[] = [member(alice, "admin")], options: {
  unavailable?: boolean; searchError?: boolean; pending?: boolean; pageSize?: number;
  noProjects?: boolean;
  onAdminList?: () => void;
} = {}) {
  let members = [...initial];
  const users = [alice, bob, charlie, disabled];
  let retryId: string | null = null;
  const searchUsers = ({ request }: { request: Request }) => {
    if (options.searchError) return HttpResponse.json({ error: "Directory unavailable" }, { status: 503 });
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.toLowerCase() ?? "";
    const matches = users.filter(user =>
      `${user.displayName} ${user.email} ${user.id}`.toLowerCase().includes(query),
    );
    const cursor = url.searchParams.get("cursor");
    const start = cursor ? matches.findIndex(user => user.id === cursor) + 1 : 0;
    const page = matches.slice(start, start + (options.pageSize ?? matches.length));
    return HttpResponse.json({ items: page, ...(start + page.length < matches.length ? { nextCursor: page[page.length - 1].id } : {}) });
  };
  return [
    http.get("/api/v1/projects", () => HttpResponse.json(options.noProjects ? [] : [project])),
    http.get("/api/v1/projects/:id", () => HttpResponse.json(project)),
    http.get("/api/v1/projects/:id/members/lookup/:userId", ({ params }) => {
      const user = users.find(user => user.id === params.userId);
      return !user ? HttpResponse.json({ error: "Enrolled user not found" }, { status: 404 })
        : user.disabled ? HttpResponse.json({ error: "Disabled users cannot receive new project access" }, { status: 409 })
        : HttpResponse.json(user);
    }),
    http.get("/api/v1/projects/:id/members/search", searchUsers),
    http.get("/api/v1/admin/platform-admins", () => {
      options.onAdminList?.();
      return HttpResponse.json({ items: [{ ...alice, pending: false }] });
    }),
    http.get("/api/v1/projects/:id/members", () => options.unavailable
      ? HttpResponse.json({ error: "Authority unavailable" }, { status: 503 })
      : HttpResponse.json(members)),
    http.get("/api/v1/admin/users/search", searchUsers),
    http.put<{ id: string; userId: string }, { role: ProjectRole; revision: number }>("/api/v1/projects/:id/members/:userId", async ({ request, params }) => {
      const body: { role: ProjectRole; revision: number } = await request.json();
      const current = members.find(row => row.userId === params.userId);
      if (body.revision !== (current?.revision ?? 0)) return HttpResponse.json({ error: "Revision mismatch" }, { status: 409 });
      const id = request.headers.get("Idempotency-Key");
      if (!id || (retryId && id !== retryId)) return HttpResponse.json({ error: "Retry changed the operation key" }, { status: 409 });
      if (options.pending && !retryId) { retryId = id; return HttpResponse.json({ operationId: id, state: "pending" }, { status: 202 }); }
      const user = [alice, bob, charlie].find(user => user.id === params.userId);
      if (!user) return HttpResponse.json({ error: "Unknown user" }, { status: 404 });
      members = [...members.filter(row => row.userId !== user.id), member(user, body.role, { revision: body.revision + 1 })];
      return HttpResponse.json({ operationId: id, state: "completed", revision: body.revision + 1 });
    }),
    http.delete<{ id: string; userId: string }, { revision: number }>("/api/v1/projects/:id/members/:userId", async ({ request, params }) => {
      const body: { revision: number } = await request.json();
      const current = members.find(row => row.userId === params.userId);
      if (body.revision !== current?.revision) return HttpResponse.json({ error: "Revision mismatch" }, { status: 409 });
      members = members.map(row => row.userId === params.userId ? { ...row, revokedAt: "2026-01-02T00:00:00Z", revision: row.revision + 1 } : row);
      return HttpResponse.json({ operationId: "remove-member", state: "completed", revision: body.revision + 1 });
    }),
  ];
}
const meta = {
  component: AccessAdministration,
  decorators: [(Story, context) => <AuthContext.Provider value={context.parameters.projectAdmin ? projectAdminAuth : platformAuth}><Story /></AuthContext.Provider>],
  tags: ["ai-generated", "needs-work"],
  parameters: { msw: { handlers: handlers() } },
} satisfies Meta<typeof AccessAdministration>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectAdminAddsByName: Story = {
  parameters: { projectAdmin: true, msw: { handlers: [
    http.get("/api/v1/admin/users/search", () => { throw new Error("Project admin must never query the global directory"); }),
    http.get("/api/v1/projects", () => { throw new Error("Project admin must never query the control-plane inventory"); }),
    ...handlers(),
  ] } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Manage this project</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Manage this project" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await expect(dialog.getByText(/Find an existing Scope user/)).toBeVisible();
    await userEvent.type(dialog.getByLabelText("Search users"), "bob");
    await userEvent.click(await dialog.findByRole("button", { name: /Bob Example/ }));
    await userEvent.selectOptions(dialog.getByLabelText("Project role"), "admin");
    await userEvent.click(dialog.getByRole("button", { name: "Add to project" }));
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getAllByText("Project admin")).toHaveLength(2);
    await expect(canvas.queryByRole("link", { name: "All project access" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
  },
};

export const ProjectAdminChangesAndRemovesMember: Story = {
  parameters: { projectAdmin: true, msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")]) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Manage this project</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Manage this project" }));
    for (const role of ["contributor", "admin", "reader"]) {
      await userEvent.click(await canvas.findByRole("button", { name: "Change role for Bob Example" }));
      const dialog = within(await screen.findByRole("dialog"));
      await userEvent.selectOptions(dialog.getByLabelText("Project role"), role);
      await userEvent.click(dialog.getByRole("button", { name: "Save role" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(canvas.getByRole("button", { name: "Change role for Bob Example" })).toBeEnabled());
    }
    await userEvent.click(canvas.getByRole("button", { name: "Remove Bob Example" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: /^Remove access/ }));
    await waitFor(() => expect(canvas.queryByText("Bob Example")).not.toBeInTheDocument());
  },
};

export const ProjectAdminSelfDemotionWarning: Story = {
  parameters: { projectAdmin: true },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Manage this project</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Manage this project" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Change role for Alice Example" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText("Project role"), "reader");
    await expect(dialog.getByRole("alert")).toHaveTextContent("You will lose membership-management access");
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await userEvent.click(canvas.getByRole("button", { name: "Remove Alice Example" }));
    await expect(within(await screen.findByRole("alertdialog")).getByText(/You will lose access/)).toBeVisible();
  },
};

export const ProjectAdminSearchDisabledAndMissing: Story = {
  parameters: { projectAdmin: true },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Manage this project</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Manage this project" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.type(dialog.getByLabelText("Search users"), "disabled");
    await expect(await dialog.findByRole("button", { name: /Disabled user/ })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
    await userEvent.clear(dialog.getByLabelText("Search users"));
    await userEvent.type(dialog.getByLabelText("Search users"), "nobody-enrolled");
    await expect(await dialog.findByText("No users found.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
  },
};

export const ProjectAdminSearchEmailAndPagination: Story = {
  parameters: { projectAdmin: true, msw: { handlers: handlers(undefined, { pageSize: 1 }) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Manage this project</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Manage this project" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(await dialog.findByRole("button", { name: "More users" }));
    await userEvent.click(await dialog.findByRole("button", { name: /Bob Example/ }));
    await userEvent.click(dialog.getByRole("button", { name: "Back to first page" }));
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
    await userEvent.type(dialog.getByLabelText("Search users"), "bob@example.test");
    await userEvent.click(await dialog.findByRole("button", { name: /Bob Example/ }));
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeEnabled();
  },
};

export const ProjectAdminSearchUnavailable: Story = {
  parameters: { projectAdmin: true, msw: { handlers: handlers(undefined, { searchError: true }) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Manage this project</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Manage this project" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await expect(await dialog.findByRole("alert")).toHaveTextContent("Directory unavailable");
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Try again" })).toBeEnabled();
  },
};

export const ProjectAdminPendingRetry: Story = {
  parameters: { projectAdmin: true, msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")], { pending: true }) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Manage this project</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Manage this project" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Change role for Bob Example" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText("Project role"), "admin");
    await userEvent.click(dialog.getByRole("button", { name: "Save role" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("pending operator repair");
    await expect(canvas.getByText(/contact an operator with operation ID/)).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "All project access" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Retry change" }));
    await expect(await canvas.findByRole("status")).toHaveTextContent("completed");
    await waitFor(() => expect(canvas.queryByRole("button", { name: "Retry change" })).not.toBeInTheDocument());
  },
};

async function chooseProject() {
  const selector = await screen.findByRole("combobox", { name: "Project" });
  const option = await screen.findByRole("option", { name: /Scope benchmarks/ });
  await waitFor(() => expect(selector).toBeEnabled());
  await userEvent.selectOptions(selector, option);
  await expect(await within(await screen.findByRole("list", { name: "Project members" })).findByText("Alice Example")).toBeVisible();
}
async function selectBob() {
  await chooseProject();
  await userEvent.click(screen.getByRole("button", { name: "Add people" }));
  const dialog = within(await screen.findByRole("dialog"));
  await userEvent.type(dialog.getByLabelText("Search users"), "bob");
  const candidate = await dialog.findByRole("button", { name: /Bob Example/ });
  await userEvent.click(candidate);
  await userEvent.selectOptions(dialog.getByLabelText("Project role"), "contributor");
  await userEvent.click(dialog.getByRole("button", { name: "Add to project" }));
}

export const CurrentMembers: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader"), member(charlie, "contributor", { revokedAt: "2026-01-02T00:00:00Z" })]) } },
  play: async ({ canvas }) => {
    await chooseProject();
    await expect(canvas.getByText("Bob Example")).toBeVisible();
    await expect(canvas.getByText("Reader")).toBeVisible();
    await expect(canvas.getByText("Project admin")).toBeVisible();
    await expect(canvas.getByText("bob@example.test")).toBeVisible();
    await expect(canvas.queryByRole("textbox", { name: "Find a member" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Charlie Example")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /Create/ })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
  },
};

export const AddPeople: Story = {
  parameters: { msw: { handlers: handlers() } },
  play: async ({ canvas }) => {
    await selectBob();
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByText("Contributor")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("completed");
    await expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
};

export const ChangeMemberRole: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")]) } },
  play: async ({ canvas }) => {
    await chooseProject();
    await userEvent.click(canvas.getByRole("button", { name: "Change role for Bob Example" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText("Project role"), "contributor");
    await userEvent.click(dialog.getByRole("button", { name: "Save role" }));
    await expect(await canvas.findByText("Contributor")).toBeVisible();
  },
};

export const RemoveMember: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")]) } },
  play: async ({ canvas }) => {
    await chooseProject();
    await userEvent.click(canvas.getByRole("button", { name: "Remove Bob Example" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: /^Remove access/ }));
    await expect(await canvas.findByRole("status")).toHaveTextContent("completed");
    await waitFor(() => expect(canvas.queryByText("Bob Example")).not.toBeInTheDocument());
  },
};

export const RegrantRevokedMember: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader", { revokedAt: "2026-01-02T00:00:00Z", revision: 4 })]) } },
  play: async ({ canvas }) => {
    await selectBob();
    await expect(await canvas.findByRole("status")).toHaveTextContent("completed");
    await expect(canvas.getByText("Bob Example")).toBeVisible();
  },
};

export const MembershipAuthorityUnavailable: Story = {
  parameters: { msw: { handlers: handlers([], { unavailable: true }) } },
  play: async ({ canvas }) => {
    await userEvent.selectOptions(canvas.getByLabelText("Project"), await canvas.findByRole("option", { name: /Scope benchmarks/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Membership authority unavailable");
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
  },
};

export const DirectoryUnavailable: Story = {
  parameters: { msw: { handlers: handlers(undefined, { searchError: true }) } },
  play: async () => {
    await chooseProject();
    await userEvent.click(screen.getByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await expect(await dialog.findByRole("alert")).toHaveTextContent("User search unavailable");
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
  },
};

export const PendingChangeRetry: Story = {
  parameters: { msw: { handlers: handlers(undefined, { pending: true }) } },
  play: async ({ canvas }) => {
    await selectBob();
    await expect(await canvas.findByRole("alert")).toHaveTextContent("pending operator repair");
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Retry change" }));
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("completed");
  },
};

export const ExistingAndDisabledUsers: Story = {
  parameters: { msw: { handlers: handlers() } },
  play: async () => {
    await chooseProject();
    await userEvent.click(screen.getByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await expect(await dialog.findByRole("button", { name: /Alice Example/ })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: /Disabled user/ })).toBeDisabled();
  },
};

export const PaginatedUsers: Story = {
  parameters: { msw: { handlers: handlers(undefined, { pageSize: 2 }) } },
  play: async () => {
    await chooseProject();
    await userEvent.click(screen.getByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(await dialog.findByRole("button", { name: "More users" }));
    await userEvent.click(await dialog.findByRole("button", { name: /Charlie Example/ }));
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeEnabled();
    await userEvent.click(dialog.getByRole("button", { name: "Back to first page" }));
    await expect(await dialog.findByRole("button", { name: /Bob Example/ })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
    await userEvent.type(dialog.getByLabelText("Search users"), "nobody-matches");
    await expect(await dialog.findByText("No users found.")).toBeVisible();
  },
};

export const SignedAliasWithoutVerifiedEmail: Story = {
  parameters: { msw: { handlers: handlers([member({ ...bob, email: undefined, alias: "bob.alias@example.test" }, "reader")]) } },
  play: async ({ canvas }) => {
    await userEvent.selectOptions(canvas.getByLabelText("Project"), await canvas.findByRole("option", { name: /Scope benchmarks/ }));
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByText("bob.alias@example.test")).toBeVisible();
    await expect(canvas.queryByText(bob.id)).not.toBeInTheDocument();
  },
};

function AccessAtRoute() {
  const { pathname } = useLocation();
  return pathname === "/access" ? <AccessAdministration /> : null;
}

const specificProjectAdminRequests = fn();
export const SpecificProject: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")], { onAdminList: specificProjectAdminRequests }) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Open project access</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    specificProjectAdminRequests.mockClear();
    await userEvent.click(canvas.getByRole("link", { name: "Open project access" }));
    await expect(await canvas.findByText(project.name)).toBeVisible();
    await expect(await within(await canvas.findByRole("list", { name: "Project members" })).findByText("Alice Example")).toBeVisible();
    await expect(canvas.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
    await expect(specificProjectAdminRequests).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Change role for Bob Example" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText("Project role"), "contributor");
    await userEvent.click(dialog.getByRole("button", { name: "Save role" }));
    await expect(await canvas.findByRole("status")).toHaveTextContent("completed");
    await expect(canvas.getByText("Contributor")).toBeVisible();
    await expect(specificProjectAdminRequests).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("link", { name: "All project access" }));
    await expect(await canvas.findByRole("combobox", { name: "Project" })).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
    await expect(specificProjectAdminRequests).not.toHaveBeenCalled();
    const selector = await canvas.findByRole("combobox", { name: "Project" });
    await userEvent.selectOptions(selector, projectId);
    await expect(await within(await canvas.findByRole("list", { name: "Project members" })).findByText("Alice Example")).toBeVisible();
    await expect(canvas.getByRole("combobox", { name: "Project" })).toBeVisible();
    await userEvent.click(canvas.getByRole("link", { name: "Open project access" }));
    await expect(await canvas.findByText(project.name)).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
    await expect(specificProjectAdminRequests).not.toHaveBeenCalled();
  },
};

export const SpecificProjectPendingOperatorGuidance: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader", { pending: true, operationId: "pending-member-change" })]) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Open project access</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Open project access" }));
    await expect(await canvas.findByText("pending-member-change")).toBeVisible();
    await expect(canvas.getByText(/Contact an operator/)).toBeVisible();
    await expect(canvas.queryByLabelText("Operation ID")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("link", { name: "Manage pending change in All project access" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("link", { name: "All project access" }));
    await chooseProject();
    await expect(canvas.getByText("pending-member-change")).toBeVisible();
  },
};

export const SpecificProjectUnconfirmedChangeOperatorGuidance: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")], { pending: true }) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Open project access</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Open project access" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Change role for Bob Example" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText("Project role"), "contributor");
    await userEvent.click(dialog.getByRole("button", { name: "Save role" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("pending operator repair");
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
    const notice = canvas.getByText(/Completion is not confirmed/);
    await expect(notice).toHaveTextContent("contact an operator with operation ID");
    await expect(notice.querySelector("code")?.textContent).toBeTruthy();
    await expect(within(notice).queryByRole("link")).not.toBeInTheDocument();
    await expect(canvas.queryByLabelText("Operation ID")).not.toBeInTheDocument();
  },
};

export const PendingRemovalSurvivesNavigation: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader", {
    pending: true, operationId: "pending-removal", revokedAt: "2026-01-02T00:00:00Z",
  })]) } },
  play: async ({ canvas }) => {
    await chooseProject();
    await expect(canvas.getByText("Bob Example")).toBeVisible();
    await expect(canvas.getByText("pending-removal")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Remove Bob Example" })).toBeDisabled();
  },
};

export const MissingSpecificProject: Story = {
  render: () => <><Link to="/access?projectId=missing">Open missing project</Link><AccessAdministration /></>,
  play: async ({ canvas }) => {
    await chooseProject();
    await userEvent.click(canvas.getByRole("link", { name: "Open missing project" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("This project is unavailable");
    await expect(canvas.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("list", { name: "Project members" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
  },
};

const otherProject = { ...project, _id: "66666666-6666-4666-8666-666666666666", name: "Other project" };
export const SpecificProjectNavigation: Story = {
  parameters: { msw: { handlers: [
    http.get("/api/v1/projects", () => HttpResponse.json([project, otherProject])),
    http.get("/api/v1/projects/:id/members", ({ params }) => HttpResponse.json(params.id === projectId
      ? [member(alice, "admin")] : [member(bob, "reader", { projectId: otherProject._id })])),
    ...handlers(),
  ] } },
  render: () => <>
    <Link to={`/access?projectId=${projectId}`}>First project</Link>
    <Link to={`/access?projectId=${otherProject._id}`}>Second project</Link>
    <AccessAdministration />
  </>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "First project" }));
    await expect(await within(await canvas.findByRole("list", { name: "Project members" })).findByText("Alice Example")).toBeVisible();
    await userEvent.click(canvas.getByRole("link", { name: "Second project" }));
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByText(otherProject.name)).toBeVisible();
    await expect(within(canvas.getByRole("list", { name: "Project members" })).queryByText("Alice Example")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
  },
};

export const RestoreDeletedProject: Story = {
  parameters: { msw: { handlers: (() => {
    let deletedAt: string | undefined = "2026-01-02T00:00:00Z";
    return [
      http.get("/api/v1/projects", () => HttpResponse.json([{ ...project, deletedAt }])),
      http.post("/api/v1/projects/:id/restore", () => {
        deletedAt = undefined;
        return HttpResponse.json({ ...project, revision: 2 });
      }),
      ...handlers(),
    ];
  })() } },
  play: async ({ canvas }) => {
    await chooseProject();
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Restore project" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Add people" })).toBeEnabled());
    await expect(canvas.queryByRole("button", { name: "Restore project" })).not.toBeInTheDocument();
  },
};

const globalAdminRequests = fn();
export const ProjectAccessOnly: Story = {
  parameters: { msw: { handlers: handlers([], { noProjects: true, onAdminList: globalAdminRequests }) } },
  render: () => { globalAdminRequests.mockClear(); return <AccessAdministration />; },
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole("combobox", { name: "Project" })).toBeEnabled());
    await expect(canvas.getByRole("heading", { name: "Project members" })).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Add platform admin" })).not.toBeInTheDocument();
    await expect(globalAdminRequests).not.toHaveBeenCalled();
  },
};
