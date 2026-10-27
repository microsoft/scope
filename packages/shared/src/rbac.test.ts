// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  AccessCapabilitiesSchema, PlatformAdminListSchema, PlatformAdminPromotionSchema,
  ProjectRoleSchema, projectPermissions, REPORT_GENERATION_ENABLED, resolveAuthEnabledFlag,
} from "./rbac.js";

describe("Shared authentication and RBAC switch", () => {
  it.each([undefined, "", "typo", "f alse", "o ff", "true", "1", "yes", "on", " TRUE "])("keeps security enabled for %j", value => {
    expect(resolveAuthEnabledFlag(value)).toBe(true);
  });
  it.each(["false", "0", "no", "off", " OFF "])("accepts explicit opt-out %j", value => {
    expect(resolveAuthEnabledFlag(value)).toBe(false);
  });
});

describe("Fixed project role bundles", () => {
  it.each([
    ["reader", ["content:read"]],
    ["contributor", ["content:read", "content:write", "content:delete"]],
    ["admin", ["content:read", "content:write", "content:delete", "settings:write", "members:write"]],
  ] as const)("%s has only its fixed project-scoped permissions", (role, expected) => {
    expect(projectPermissions(role)).toEqual(expected);
  });
  it("permits membership management only in the fixed admin bundle", () => {
    const membership = { projectId: "project-a", role: "admin", permissions: projectPermissions("admin"), revision: 1 };
    expect(AccessCapabilitiesSchema.parse({ platformAdmin: false, reportsEnabled: false, memberships: [membership] }).platformAdmin).toBe(false);
    for (const role of ["reader", "contributor"]) {
      expect(AccessCapabilitiesSchema.safeParse({
        platformAdmin: false, reportsEnabled: false, memberships: [{ ...membership, role }],
      }).success).toBe(false);
    }
  });

  describe("Add-only platform administration contracts", () => {
    it("accepts only a revision, never an arbitrary role, identity or disable flag", () => {
      expect(PlatformAdminPromotionSchema.parse({ revision: 0 })).toEqual({ revision: 0 });
      for (const input of [{}, { revision: -1 }, { revision: 1.5 }, { revision: "0" },
        { revision: 0, role: "user" }, { revision: 0, disabled: false }, { revision: 0, email: "someone@example.test" }]) {
        expect(PlatformAdminPromotionSchema.safeParse(input).success).toBe(false);
      }
    });

    it("requires a platform role and explicit pending state in the paginated roster", () => {
      const user = { id: "scope-user", role: "admin", disabled: false, revision: 1, pending: false };
      expect(PlatformAdminListSchema.parse({ items: [user], nextCursor: user.id }).items).toEqual([user]);
      expect(PlatformAdminListSchema.safeParse({ items: [{ ...user, role: "user" }] }).success).toBe(false);
      expect(PlatformAdminListSchema.safeParse({ items: [{ ...user, pending: undefined }] }).success).toBe(false);
    });
  });
  it("rejects unapproved/custom roles and disables new report generation", () => {
    for (const role of ["owner", "platform-admin", "*", "custom"]) expect(ProjectRoleSchema.safeParse(role).success).toBe(false);
    expect(REPORT_GENERATION_ENABLED).toBe(false);
  });
});
