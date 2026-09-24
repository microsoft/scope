// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_USER_ID,
  SYSTEM_USER_ID,
  UserDocumentSchema,
} from "./user-schema.js";

describe("UserDocumentSchema", () => {
  it("parses a full document", () => {
    const now = new Date();
    const doc = UserDocumentSchema.parse({
      _id: "user-uuid",
      idp: "entra",
      idpTenant: "tenant-1",
      idpSubject: "subject-1",
      email: "ada@example.com",
      emailVerified: true,
      displayName: "Ada Lovelace",
      role: "admin",
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    });
    expect(doc.role).toBe("admin");
    expect(doc.displayName).toBe("Ada Lovelace");
  });

  it("defaults role to 'user'", () => {
    const now = new Date();
    const doc = UserDocumentSchema.parse({
      _id: "user-uuid",
      idp: "entra",
      idpTenant: "tenant-1",
      idpSubject: "subject-1",
      createdAt: now,
      updatedAt: now,
    });
    expect(doc.role).toBe("user");
    expect(doc.email).toBeUndefined();
  });

  it("rejects a document missing identity fields", () => {
    const now = new Date();
    const result = UserDocumentSchema.safeParse({
      _id: "user-uuid",
      idp: "entra",
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });

  it("exposes reserved id sentinels", () => {
    expect(SYSTEM_USER_ID).toBe("system");
    expect(ANONYMOUS_USER_ID).toBe("anonymous");
  });
});
