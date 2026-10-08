// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Request } from "express";
import { ANONYMOUS_USER_ID, type VerifiedIdentity } from "shared";

/** Verified IdP credentials, before resolving application access. Request-local only. */
export interface VerifiedAuthContext {
  identity: VerifiedIdentity;
  token: string;
}

/**
 * The principal set on `req.user` for every request.
 *
 * This is identity only. Authorization (roles/permissions enforcement) is NOT
 * part of this milestone — `role` is carried as advisory metadata, never used
 * to allow or deny a request here.
 */
export interface AuthenticatedUser {
  /** Scope User ID (UUID) for authenticated users, or "anonymous". */
  id: string;
  /** Whether a valid token was presented and resolved to a user. */
  isAuthenticated: boolean;
  /** Loose role string (advisory only). */
  role?: string;
  email?: string;
  displayName?: string;
  idp?: string;
  idpTenant?: string;
  idpSubject?: string;
  /** Reserved for future service-to-service principals. Always false today. */
  isService?: boolean;
}

// Augment Express's Request so handlers can read `req.user`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: VerifiedAuthContext;
      user?: AuthenticatedUser;
    }
  }
}

/** Shared, immutable anonymous principal. */
export const ANONYMOUS_USER: AuthenticatedUser = Object.freeze({
  id: ANONYMOUS_USER_ID,
  isAuthenticated: false,
});

/** Read the principal for a request, defaulting to anonymous. */
export function getUser(req: Request): AuthenticatedUser {
  return req.user ?? ANONYMOUS_USER;
}
