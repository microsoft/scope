// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

/** Only an explicit opt-out disables authentication and project RBAC. */
export function resolveAuthEnabledFlag(value: string | undefined): boolean {
  return !["false", "0", "no", "off"].includes(value?.trim().toLowerCase() ?? "");
}

export const ApiAuthModeSchema = z.object({ authEnabled: z.boolean() });

export const ProjectRoleSchema = z.enum(["reader", "contributor", "admin"]);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;
export type ProjectPermission = "content:read" | "content:write" | "content:delete" | "settings:write" | "members:write";

const permissions: Readonly<Record<ProjectRole, readonly ProjectPermission[]>> = {
  reader: ["content:read"],
  contributor: ["content:read", "content:write", "content:delete"],
  admin: ["content:read", "content:write", "content:delete", "settings:write", "members:write"],
};

export function projectPermissions(role: ProjectRole): readonly ProjectPermission[] {
  return permissions[role];
}

export const MembershipSchema = z.object({
  _id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  role: ProjectRoleSchema,
  revision: z.number().int().positive(),
  createdAt: z.date(),
  updatedAt: z.date(),
  createdByUserId: z.string(),
  revokedAt: z.date().optional(),
  lastOperationId: z.string(),
  appliedOperationIds: z.array(z.string()),
});
export type ProjectMembership = z.infer<typeof MembershipSchema>;

export const AccessCapabilitiesSchema = z.object({
  platformAdmin: z.boolean(),
  reportsEnabled: z.literal(false),
  memberships: z.array(z.object({
    projectId: z.string().min(1),
    role: ProjectRoleSchema,
    permissions: z.array(z.enum(["content:read", "content:write", "content:delete", "settings:write", "members:write"])).readonly(),
    revision: z.number().int().positive(),
  }).strict().refine(membership => {
    const expected = projectPermissions(membership.role);
    return membership.permissions.length === expected.length &&
      expected.every(permission => membership.permissions.includes(permission));
  }, "Permissions must match the fixed project role")).refine(
    memberships => new Set(memberships.map(membership => membership.projectId)).size === memberships.length,
    "Project memberships must be unique",
  ),
}).strict();
export type AccessCapabilities = z.infer<typeof AccessCapabilitiesSchema>;

export const AccessUserSummarySchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  email: z.string().optional(),
  alias: z.string().optional(),
  role: z.string(),
  disabled: z.boolean(),
  revision: z.number().int().nonnegative(),
});
export type AccessUserSummary = z.infer<typeof AccessUserSummarySchema>;

export const AccessUserSearchResultSchema = z.object({
  items: z.array(AccessUserSummarySchema),
  nextCursor: z.string().optional(),
});
export type AccessUserSearchResult = z.infer<typeof AccessUserSearchResultSchema>;

export const PlatformAdminSummarySchema = AccessUserSummarySchema.extend({
  role: z.literal("admin"),
  pending: z.boolean(),
  operationId: z.string().optional(),
});
export type PlatformAdminSummary = z.infer<typeof PlatformAdminSummarySchema>;

export const PlatformAdminListSchema = z.object({
  items: z.array(PlatformAdminSummarySchema),
  nextCursor: z.string().optional(),
});
export type PlatformAdminList = z.infer<typeof PlatformAdminListSchema>;

export const PlatformAdminPromotionSchema = z.object({
  revision: z.number().int().nonnegative(),
}).strict();

export const ProjectMembershipSummarySchema = z.object({
  _id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  role: ProjectRoleSchema,
  revision: z.number().int().positive(),
  revokedAt: z.string().optional(),
  pending: z.boolean(),
  operationId: z.string().optional(),
  user: AccessUserSummarySchema.optional(),
});
export type ProjectMembershipSummary = z.infer<typeof ProjectMembershipSummarySchema>;

/** Report generation is deliberately unavailable until service authorization ships. */
export const REPORT_GENERATION_ENABLED = false;
