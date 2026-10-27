// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

/**
 * The `users` collection document.
 *
 * Canonical identity, platform role and disable authority. Project role bundles
 * live in project_memberships. Legacy permission override fields stay inactive.
 */
export const UserDocumentSchema = z.object({
  /** Scope User ID — an app-owned UUID used by memberships and audit references. */
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
  /** Advisory login label from signed profile claims; never an identity or permission key. */
  alias: z.string().optional(),
  /** Stored platform role; canonical authorization rejects unknown values. */
  role: z.string().default("user"),
  revision: z.number().int().nonnegative().optional(),
  lastOperationId: z.string().optional(),
  appliedOperationIds: z.array(z.string()).optional(),
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
