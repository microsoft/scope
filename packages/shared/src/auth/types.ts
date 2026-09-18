// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Pluggable identity-provider (IdP) abstraction.
 *
 * An {@link AuthProvider} verifies a bearer access token and returns identity
 * only — it never reads IdP-side roles or groups. Authorization (roles /
 * permissions) is owned by Scope and is intentionally NOT part of this
 * milestone; see docs/architecture/auth-rbac.md.
 */

/** Identity extracted from a verified access token. */
export interface VerifiedIdentity {
  /** Provider id, e.g. "entra". */
  idp: string;
  /** IdP tenant id (Entra `tid`). Part of the durable identity key. */
  idpTenant: string;
  /** Stable, IdP-unique subject within a tenant (Entra `oid`). */
  idpSubject: string;
  /** Advisory email (Entra `email` / `preferred_username`). Never an authz input. */
  email?: string;
  /** Display name (Entra `name`). */
  displayName?: string;
  /** Whether the IdP asserted the email as verified. */
  emailVerified?: boolean;
}

/** Backend-side token verifier. Decouples Scope from IdP specifics. */
export interface AuthProvider {
  /** Provider id, e.g. "entra". */
  readonly id: string;
  /** Verify a bearer access token. Throws {@link AuthError} on any failure. */
  verifyAccessToken(token: string): Promise<VerifiedIdentity>;
}

/**
 * IdP configuration the CLI and Portal need. Kept here as a shared, reviewable
 * shape so a future IdP swap is a config change, not a code change.
 */
export interface AuthClientConfig {
  provider: string;
  authority: string;
  clientId: string;
  scopes: string[];
  audience: string;
}

/** Reasons an {@link AuthError} can be raised (mapped to HTTP status upstream). */
export type AuthErrorCode =
  | "invalid_token"
  | "expired_token"
  | "invalid_audience"
  | "invalid_issuer"
  | "missing_claim"
  | "not_configured"
  | "service_unavailable";

/** Error thrown for any authentication failure. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Profile fields resolved for a user (from token claims today; Graph later). */
export interface UserProfile {
  email?: string;
  displayName?: string;
  emailVerified?: boolean;
}

/**
 * Seam for resolving a user's profile. The default implementation
 * ({@link ClaimsProfileEnricher}) reads token claims — no network call, no
 * client secret. A future `GraphProfileEnricher` (On-Behalf-Of → Microsoft
 * Graph) implements the same interface and is dropped in via config, without
 * touching call sites.
 */
export interface ProfileEnricher {
  /** Enricher id, e.g. "claims" or "graph". */
  readonly id: string;
  /** Resolve the profile for a verified identity. `rawToken` enables OBO later. */
  enrich(identity: VerifiedIdentity, rawToken: string): Promise<UserProfile>;
}
