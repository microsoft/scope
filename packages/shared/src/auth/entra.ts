// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  createRemoteJWKSet,
  jwksCache,
  jwtVerify,
  type JWK,
  type JSONWebKeySet,
  type JWKSCacheInput,
  type JWTHeaderParameters,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyResult,
} from "jose";
import { AuthError, type AuthProvider, type VerifiedIdentity } from "./types.js";

interface EntraJwk extends JWK {
  issuer?: unknown;
}

interface EntraJsonWebKeySet extends JSONWebKeySet {
  keys: EntraJwk[];
}

/** A key resolver paired with the metadata used to select its verification key. */
export interface EntraJwks {
  resolve: JWTVerifyGetKey;
  getCurrentJwks(): EntraJsonWebKeySet | undefined;
}

/** Default Entra v2.0 per-tenant issuer template. `{tenantid}` is substituted. */
const DEFAULT_ISSUER_TEMPLATE =
  "https://login.microsoftonline.com/{tenantid}/v2.0";

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ERR_JWKS_TIMEOUT",
]);

const JWKS_KEY_SELECTION_ERROR_CODES = new Set([
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

export interface EntraIdAuthProviderOptions {
  /**
   * Expected audience — the API app registration client id (a GUID) and/or its
   * `api://<client-id>` Application ID URI. Pass an array to accept both.
   */
  audience: string | string[];
  /**
   * OIDC authority, e.g. `https://login.microsoftonline.com/common` or
   * `.../organizations`. Used to derive the JWKS endpoint. Multi-tenant: any
   * tenant is accepted and the issuer is validated per-tenant against
   * {@link EntraIdAuthProviderOptions.issuerTemplate}.
   */
  authority: string;
  /** Explicit JWKS URI. Defaults to `${authority}/discovery/v2.0/keys`. */
  jwksUri?: string;
  /** Issuer template with a `{tenantid}` placeholder. Defaults to Entra v2.0. */
  issuerTemplate?: string;
  /** Injectable metadata-aware key source for tests (defaults to a cached remote JWKS). */
  jwks?: EntraJwks;
}

/**
 * {@link AuthProvider} backed by Microsoft Entra ID.
 *
 * Verifies RS256 access tokens against the tenant JWKS, checks audience and a
 * per-tenant issuer (no `tid` pinning — any tenant is accepted), and extracts
 * identity claims. Never inspects roles/groups.
 */
export class EntraIdAuthProvider implements AuthProvider {
  readonly id = "entra";

  private readonly audience: string | string[];
  private readonly issuerTemplate: string;
  private readonly resolveKey: JWTVerifyGetKey;
  private readonly getCurrentJwks: () => EntraJsonWebKeySet | undefined;

  constructor(options: EntraIdAuthProviderOptions) {
    this.audience = options.audience;
    this.issuerTemplate = options.issuerTemplate ?? DEFAULT_ISSUER_TEMPLATE;

    const jwksUri =
      options.jwksUri ??
      `${options.authority.replace(/\/+$/, "")}/discovery/v2.0/keys`;
    const jwks = options.jwks ?? createRemoteEntraJwks(new URL(jwksUri));
    this.resolveKey = withJwksRetrievalRetry(jwks.resolve);
    this.getCurrentJwks = () => jwks.getCurrentJwks();
  }

  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    const { payload, protectedHeader } =
      await this.verifySignatureAndClaims(token);

    const idpTenant = asString(payload.tid);
    if (!idpTenant) {
      throw new AuthError("missing_claim", "Token is missing the `tid` claim");
    }
    const idpSubject = asString(payload.oid);
    if (!idpSubject) {
      throw new AuthError("missing_claim", "Token is missing the `oid` claim");
    }
    const tokenExpiresAt = payload.exp;
    if (typeof tokenExpiresAt !== "number") {
      throw new AuthError("missing_claim", "Token is missing the `exp` claim");
    }

    // Multi-tenant issuer validation: any tenant is accepted, but the issuer
    // must match the per-tenant v2.0 template for the tenant the token claims.
    const expectedIssuer = this.issuerTemplate.replace("{tenantid}", idpTenant);
    if (payload.iss !== expectedIssuer) {
      throw new AuthError(
        "invalid_issuer",
        `Unexpected token issuer: ${String(payload.iss)}`,
      );
    }
    validateSigningKeyIssuer(
      this.getCurrentJwks(),
      protectedHeader,
      expectedIssuer,
      idpTenant,
    );

    const email =
      asString(payload.email) ?? asString(payload.preferred_username);
    const displayName = asString(payload.name);
    const emailVerified =
      typeof payload.email_verified === "boolean"
        ? payload.email_verified
        : undefined;

    return {
      idp: this.id,
      idpTenant,
      idpSubject,
      email,
      displayName,
      emailVerified,
    };
  }

  private async verifySignatureAndClaims(
    token: string,
  ): Promise<JWTVerifyResult<JWTPayload>> {
    try {
      return await jwtVerify(token, this.resolveKey, {
        audience: this.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp"],
      });
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }

      const code = asString((err as { code?: unknown }).code) ?? "";
      const message = err instanceof Error ? err.message : String(err);

      if (code === "ERR_JWT_EXPIRED") {
        throw new AuthError("expired_token", "Access token has expired");
      }
      if (
        code === "ERR_JWT_CLAIM_VALIDATION_FAILED" &&
        asString((err as { claim?: unknown }).claim) === "aud"
      ) {
        // jose raises this for a failed audience (and other) claim checks.
        throw new AuthError("invalid_audience", message);
      }
      throw new AuthError(
        "invalid_token",
        `Token verification failed: ${message}`,
      );
    }
  }
}

function createRemoteEntraJwks(url: URL): EntraJwks {
  // This closure-private cache exposes the fetched metadata without allowing
  // callers to replace the trusted JWKS contents.
  const cache: JWKSCacheInput = {};
  const remoteJwks = createRemoteJWKSet(url, { [jwksCache]: cache });
  return {
    resolve: remoteJwks,
    getCurrentJwks: () => ("jwks" in cache ? cache.jwks : undefined),
  };
}

function validateSigningKeyIssuer(
  jwks: EntraJsonWebKeySet | undefined,
  protectedHeader: JWTHeaderParameters,
  tokenIssuer: string,
  tenantId: string,
): void {
  const matchingKeys =
    jwks?.keys.filter((jwk) => isMatchingVerificationJwk(jwk, protectedHeader)) ??
    [];
  if (matchingKeys.length !== 1) {
    throw new AuthError(
      "invalid_issuer",
      "Unable to identify signing key issuer metadata",
    );
  }

  const keyIssuer = asString(matchingKeys[0].issuer);
  if (
    !keyIssuer ||
    keyIssuer.replaceAll("{tenantid}", tenantId) !== tokenIssuer
  ) {
    throw new AuthError(
      "invalid_issuer",
      "Signing key issuer does not match token issuer",
    );
  }
}

function isMatchingVerificationJwk(
  jwk: EntraJwk,
  protectedHeader: JWTHeaderParameters,
): boolean {
  if (jwk.kty !== "RSA") return false;
  if (
    typeof protectedHeader.kid === "string" &&
    jwk.kid !== protectedHeader.kid
  ) {
    return false;
  }
  if (typeof jwk.alg === "string" && jwk.alg !== protectedHeader.alg) {
    return false;
  }
  if (typeof jwk.use === "string" && jwk.use !== "sig") {
    return false;
  }
  return !Array.isArray(jwk.key_ops) || jwk.key_ops.includes("verify");
}

function withJwksRetrievalRetry(jwks: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await jwks(protectedHeader, token);
    } catch (err) {
      if (isJwksKeySelectionError(err)) {
        throw err;
      }
      if (!isTransientJwksRetrievalError(err)) {
        throw jwksUnavailableError();
      }
    }

    try {
      return await jwks(protectedHeader, token);
    } catch (err) {
      if (isJwksKeySelectionError(err)) {
        throw err;
      }
      throw jwksUnavailableError();
    }
  };
}

function isJwksKeySelectionError(err: unknown): boolean {
  return JWKS_KEY_SELECTION_ERROR_CODES.has(errorCode(err));
}

function isTransientJwksRetrievalError(err: unknown): boolean {
  const code = errorCode(err);
  if (TRANSIENT_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }

  if (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      /expected 200 OK from the JSON Web Key Set HTTP response/i.test(
        err.message,
      ))
  ) {
    return true;
  }

  return (
    typeof err === "object" &&
    err !== null &&
    "cause" in err &&
    isTransientJwksRetrievalError(err.cause)
  );
}

function errorCode(err: unknown): string {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return "";
  }
  return asString(err.code) ?? "";
}

function jwksUnavailableError(): AuthError {
  return new AuthError(
    "service_unavailable",
    "Authentication key service is unavailable",
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
