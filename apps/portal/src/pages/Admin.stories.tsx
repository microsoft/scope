// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { Link } from "react-router-dom";
import type { AccessUserSummary, PlatformAdminSummary } from "shared/rbac";
import { AuthContext } from "@/contexts/AuthContext";
import { anonymousAuth, signedInAuth } from "@/contexts/authFixtures";
import { AccessShell } from "@/components/AccessShell";
import { Admin } from "./Admin";

const alice: AccessUserSummary = { id: "22222222-2222-4222-8222-222222222222", displayName: "Alice Example", email: "alice@example.test", role: "admin", disabled: false, revision: 1 };
const bob: AccessUserSummary = { id: "33333333-3333-4333-8333-333333333333", displayName: "Bob Example", email: "bob@example.test", role: "user", disabled: false, revision: 1 };
const charlie: AccessUserSummary = { id: "44444444-4444-4444-8444-444444444444", displayName: "Charlie Example", role: "admin", disabled: true, revision: 1 };
const disabled: AccessUserSummary = { ...bob, id: "55555555-5555-4555-8555-555555555555", displayName: "Disabled user", disabled: true };
const adminAuth = { ...signedInAuth, user: signedInAuth.user && { ...signedInAuth.user, role: "admin" as const,
  capabilities: { ...signedInAuth.user.capabilities, platformAdmin: true, memberships: [] } } };

function handlers(options: {
  adminPending?: boolean; promotionConflict?: boolean; adminUnavailable?: boolean; adminPageSize?: number;
  pendingAdmin?: boolean; onAdminList?: () => void; onProjects?: () => void; onPromotion?: () => void;
} = {}) {
  let users = [alice, bob, charlie, disabled];
  let admins: PlatformAdminSummary[] = [{ ...alice, role: "admin", pending: Boolean(options.pendingAdmin),
    ...(options.pendingAdmin ? { operationId: "pending-platform-promotion" } : {}) },
    ...(options.adminPageSize ? [{ ...charlie, role: "admin" as const, pending: false }] : [])];
  let promotionId: string | null = null;
  let flag = { key: "reports", label: "Reports", enabled: true };
  return [
    http.get("/api/v1/projects", () => { options.onProjects?.(); return HttpResponse.json([]); }),
    http.get("/api/v1/feature-flags", () => HttpResponse.json([flag])),
    http.put<{ key: string }, { enabled: boolean }>("/api/v1/feature-flags/:key", async ({ request }) => {
      const body: { enabled: boolean } = await request.json();
      flag = { ...flag, enabled: body.enabled };
      return HttpResponse.json(flag);
    }),
    http.get("/api/v1/admin/platform-admins", ({ request }) => {
      options.onAdminList?.();
      if (options.adminUnavailable) return HttpResponse.json({ error: "Authority unavailable" }, { status: 503 });
      const cursor = new URL(request.url).searchParams.get("cursor");
      const start = cursor ? admins.findIndex(user => user.id === cursor) + 1 : 0;
      const page = admins.slice(start, start + (options.adminPageSize ?? 20));
      return HttpResponse.json({ items: page, ...(start + page.length < admins.length ? { nextCursor: page[page.length - 1].id } : {}) });
    }),
    http.get("/api/v1/admin/users/search", ({ request }) => {
      const query = new URL(request.url).searchParams.get("q")?.toLowerCase() ?? "";
      return HttpResponse.json({ items: users.filter(user => `${user.displayName} ${user.email} ${user.id}`.toLowerCase().includes(query)) });
    }),
    http.post<{ id: string }, { revision: number }>("/api/v1/admin/users/:id/promote", async ({ request, params }) => {
      options.onPromotion?.();
      const body: { revision: number } = await request.json();
      const id = request.headers.get("Idempotency-Key");
      const user = users.find(user => user.id === params.id);
      if (!id || (promotionId && promotionId !== id)) return HttpResponse.json({ error: "Retry changed the operation key" }, { status: 409 });
      if (!user || user.disabled || user.role !== "user" || body.revision !== user.revision || options.promotionConflict) {
        return HttpResponse.json({ error: "Target revision or preconditions changed" }, { status: 409 });
      }
      if (options.adminPending && !promotionId) {
        promotionId = id;
        return HttpResponse.json({ operationId: id, state: "pending", revision: body.revision + 1 }, { status: 202 });
      }
      const promoted = { ...user, role: "admin" as const, revision: user.revision + 1 };
      users = users.map(row => row.id === user.id ? promoted : row);
      admins = [...admins, { ...promoted, pending: false, operationId: id }];
      return HttpResponse.json({ operationId: id, state: "completed", revision: promoted.revision });
    }),
  ];
}

const meta = {
  component: Admin,
  tags: ["ai-generated", "needs-work"],
  decorators: [(Story) => <AuthContext.Provider value={adminAuth}><Story /></AuthContext.Provider>],
  parameters: { msw: { handlers: handlers() } },
} satisfies Meta<typeof Admin>;
export default meta;
type Story = StoryObj<typeof meta>;

async function reviewPromotion() {
  await userEvent.click(await screen.findByRole("button", { name: "Add platform admin" }));
  const dialog = within(await screen.findByRole("dialog"));
  await expect(await dialog.findByRole("button", { name: /Alice Example/ })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /Disabled user/ })).toBeDisabled();
  await expect(dialog.queryByLabelText("Project role")).not.toBeInTheDocument();
  await userEvent.type(dialog.getByLabelText("Search users"), "bob");
  await userEvent.click(await dialog.findByRole("button", { name: /Bob Example/ }));
  await userEvent.click(dialog.getByRole("button", { name: "Review promotion" }));
  const confirmation = within(await screen.findByRole("alertdialog"));
  await expect(confirmation.getByText(/across the entire platform/)).toBeVisible();
  return confirmation;
}

const projectRequests = fn();
export const PlatformAdminsWithoutProjects: Story = {
  parameters: { msw: { handlers: handlers({ onProjects: projectRequests }) } },
  play: async ({ canvas }) => {
    projectRequests.mockClear();
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    await expect(await section.findByText("Alice Example")).toBeVisible();
    await expect(section.getByRole("button", { name: "Add platform admin" })).toBeEnabled();
    const heading = canvas.getByRole("heading", { name: "Platform administrators" });
    await expect(canvas.getByRole("heading", { name: /^Admin$/ }).compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(heading.compareDocumentPosition(canvas.getByText("Feature Flags")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(canvas.queryByLabelText("Project")).not.toBeInTheDocument();
    await expect(projectRequests).not.toHaveBeenCalled();
  },
};

const promotionRequests = fn();
export const AddPlatformAdmin: Story = {
  parameters: { msw: { handlers: handlers({ onPromotion: promotionRequests }) } },
  play: async ({ canvas }) => {
    promotionRequests.mockClear();
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    const confirmation = await reviewPromotion();
    await expect(section.queryByText("Bob Example")).not.toBeInTheDocument();
    await userEvent.click(confirmation.getByRole("button", { name: "Cancel" }));
    await expect(promotionRequests).not.toHaveBeenCalled();
    const confirmed = await reviewPromotion();
    await userEvent.click(confirmed.getByRole("button", { name: /^Grant platform admin/ }));
    await expect(await section.findByRole("status")).toHaveTextContent("platform-admin promotion completed");
    await expect(await section.findByText("Bob Example")).toBeVisible();
    await expect(promotionRequests).toHaveBeenCalledTimes(1);
    await expect(section.queryByRole("button", { name: /Remove|Demote/ })).not.toBeInTheDocument();
  },
};

export const PendingPlatformPromotionRetry: Story = {
  parameters: { msw: { handlers: handlers({ adminPending: true }) } },
  play: async ({ canvas }) => {
    const confirmation = await reviewPromotion();
    await userEvent.click(confirmation.getByRole("button", { name: /^Grant platform admin/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("pending operator repair");
    await expect(canvas.getByRole("button", { name: "Add platform admin" })).toBeDisabled();
    await expect(canvas.queryByText("Bob Example")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Retry change" }));
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("completed");
  },
};

export const PlatformPromotionConflict: Story = {
  parameters: { msw: { handlers: handlers({ promotionConflict: true }) } },
  play: async ({ canvas }) => {
    const confirmation = await reviewPromotion();
    await userEvent.click(confirmation.getByRole("button", { name: /^Grant platform admin/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Target revision or preconditions changed");
    await expect(canvas.queryByRole("button", { name: "Retry change" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Bob Example")).not.toBeInTheDocument();
    await waitFor(() => expect(canvas.getByRole("button", { name: "Add platform admin" })).toBeEnabled());
  },
};

export const PlatformAdminAuthorityUnavailable: Story = {
  parameters: { msw: { handlers: handlers({ adminUnavailable: true }) } },
  play: async ({ canvas }) => {
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    await expect(await section.findByRole("alert")).toHaveTextContent("Platform administrator list unavailable");
    await expect(section.getByRole("button", { name: "Add platform admin" })).toBeDisabled();
    await expect(section.queryByText("No platform administrators on this page.")).not.toBeInTheDocument();
  },
};

export const PaginatedPlatformAdmins: Story = {
  parameters: { msw: { handlers: handlers({ adminPageSize: 1 }) } },
  play: async ({ canvas }) => {
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    await expect(await section.findByText("Alice Example")).toBeVisible();
    await userEvent.click(section.getByRole("button", { name: "More administrators" }));
    await expect(await section.findByText("Charlie Example")).toBeVisible();
    await expect(section.getByText("Account disabled")).toBeVisible();
    await expect(section.getByText("Platform admin (inactive)")).toBeVisible();
    await userEvent.click(section.getByRole("button", { name: "Back to first admin page" }));
    await expect(await section.findByText("Alice Example")).toBeVisible();
  },
};

export const PendingPlatformAdminOperatorGuidance: Story = {
  parameters: { msw: { handlers: handlers({ pendingAdmin: true }) } },
  play: async ({ canvas }) => {
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    await expect(await section.findByText("Change pending")).toBeVisible();
    await expect(section.getByText("Platform admin (inactive)")).toBeVisible();
    await expect(section.getByText("pending-platform-promotion")).toBeVisible();
    await expect(section.getByText(/Contact an operator/)).toBeVisible();
    await expect(canvas.queryByLabelText("Operation ID")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /Inspect operation|Reconcile operation/ })).not.toBeInTheDocument();
  },
};

export const LegacyPlatformRecoveryLinkIgnored: Story = {
  render: () => <><Link to="/admin?operationId=existing-promotion">Open promotion recovery</Link><Admin /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Open promotion recovery" }));
    await expect(await canvas.findByRole("heading", { name: "Platform administrators" })).toBeVisible();
    await expect(canvas.queryByLabelText("Operation ID")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
  },
};

export const FeatureFlagsStillEditable: Story = {
  play: async ({ canvas }) => {
    const toggle = await canvas.findByRole("switch", { name: "Reports" });
    await expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
  },
};

const disabledAdminRequests = fn();
export const AuthenticationDisabled: Story = {
  parameters: { msw: { handlers: handlers({ onAdminList: disabledAdminRequests }) } },
  render: () => {
    disabledAdminRequests.mockClear();
    return <AuthContext.Provider value={anonymousAuth}><Admin /></AuthContext.Provider>;
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("switch", { name: "Reports" })).toBeEnabled();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Add platform admin" })).not.toBeInTheDocument();
    await expect(disabledAdminRequests).not.toHaveBeenCalled();
  },
};

export const ResolvingAdminCapabilities: Story = {
  parameters: { msw: { handlers: handlers({ onAdminList: disabledAdminRequests }) } },
  render: () => {
    disabledAdminRequests.mockClear();
    return <AuthContext.Provider value={{ ...adminAuth, isReady: false, status: "resolving" }}>
      <Link to="/admin">Open Admin</Link><AccessShell><Admin /></AccessShell>
    </AuthContext.Provider>;
  },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Open Admin" }));
    await expect(canvas.getByText("Access capabilities are unavailable.")).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(disabledAdminRequests).not.toHaveBeenCalled();
  },
};

export const MemberCannotOpenAdmin: Story = {
  render: () => <AuthContext.Provider value={signedInAuth}><Link to="/admin">Open Admin</Link><AccessShell><Admin /></AccessShell></AuthContext.Provider>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Open Admin" }));
    await expect(canvas.getByText("Platform administration is not permitted.")).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
  },
};
