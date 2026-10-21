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
 * This snapshot may come from the identity cache. Authorization rereads the
 * canonical users/membership authority rather than trusting its cached role.
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

/**
 * Non-user caller authenticated by a run token or a service key. Kept separate
 * from `req.user`/`req.auth` so user identity semantics stay unchanged.
 */
export type CallerPrincipal =
  | { kind: "run"; requestId: string; runId: string; projectId: string }
  | { kind: "service"; name: string; scopes: readonly string[] };

/** Caller classification for logging and (later) authorization decisions. */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "user"; user: AuthenticatedUser }
  | CallerPrincipal;

// Augment Express's Request so handlers can read `req.user`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: VerifiedAuthContext;
      user?: AuthenticatedUser;
      /** Set only for run-token or service-key callers. */
      principal?: CallerPrincipal;
      authorizedProjectId?: string;
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

/** Classify the caller: authenticated user, run/service caller, or anonymous. */
export function getPrincipal(req: Request): Principal {
  const user = getUser(req);
  if (user.isAuthenticated) return { kind: "user", user };
  return req.principal ?? { kind: "anonymous" };
}
