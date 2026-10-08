// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

/**
 * The `users` collection document.
 *
 * Holds identity plus a deliberately loose `role` string only. The
 * role/permission model is expected to change substantially, so no role union
 * or permission types are defined here yet. `permissionsAdd` / `permissionsRemove`
 * exist for forward-compatibility and are unused today.
 */
export const UserDocumentSchema = z.object({
  /** Scope User ID — an app-owned UUID. Referenced by `ownerId` everywhere later. */
  _id: z.string(),
  /** Provider id, e.g. "entra". */
  idp: z.string(),
  /** IdP tenant id (Entra `tid`). */
  idpTenant: z.string(),
  /** Stable, IdP-unique subject within the tenant (Entra `oid`). */
  idpSubject: z.string(),
  email: z.string().optional(),
  emailVerified: z.boolean().optional(),
  displayName: z.string().optional(),
  /** Loose role string (default "user"). Intentionally NOT a union yet. */
  role: z.string().default("user"),
  /** Forward-compat, unused today. */
  permissionsAdd: z.array(z.string()).optional(),
  /** Forward-compat, unused today. */
  permissionsRemove: z.array(z.string()).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastLoginAt: z.date().optional(),
  /** When set, the user is disabled (treated as 403 by the middleware). */
  disabledAt: z.date().optional(),
});

export type UserDocument = z.infer<typeof UserDocumentSchema>;

/** Reserved Scope User ID sentinel — never assigned to a live principal. */
export const SYSTEM_USER_ID = "system";
/** Reserved Scope User ID for the unauthenticated principal. */
export const ANONYMOUS_USER_ID = "anonymous";
