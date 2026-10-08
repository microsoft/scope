// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ClaimsProfileEnricher } from "./claims-enricher.js";
import { EntraIdAuthProvider } from "./entra.js";
import type { AuthProvider, ProfileEnricher } from "./types.js";

const AUTH_ENV_KEYS = [
  "AUTH_PROVIDER",
  "AUTH_AUTHORITY",
  "AUTH_API_CLIENT_ID",
  "AUTH_SCOPES",
  "AUTH_ISSUER_TEMPLATE",
  "AUTH_JWKS_URI",
  "AUTH_BOOTSTRAP_ADMINS",
  "AUTH_BOOTSTRAP_TENANTS",
] as const;

const REQUIRED_AUTH_ENV_KEYS = [
  "AUTH_PROVIDER",
  "AUTH_AUTHORITY",
  "AUTH_API_CLIENT_ID",
] as const;

/** Everything the API needs to authenticate requests, assembled from env. */
export interface AuthRuntime {
  /** Token verifier for the configured IdP. */
  provider: AuthProvider;
  /** Profile resolver (claims today; Graph/OBO later). */
  enricher: ProfileEnricher;
  /**
   * Bootstrap admin identity keys, each formatted `${idp}:${tenant}/${subject}`
   * (e.g. `entra:<tid>/<oid>`). Promote-only — never used to demote.
   */
  bootstrapAdmins: Set<string>;
  /** Required tenant allowlist within which bootstrap promotion may apply. */
  bootstrapTenants: Set<string>;
  /** Fixed lifetime of an active Scope-user cache entry. */
  userCacheTtlSeconds: number;
}

/** Build the identity key used to match {@link AuthRuntime.bootstrapAdmins}. */
export function bootstrapAdminKey(
  idp: string,
  idpTenant: string,
  idpSubject: string,
): string {
  return `${idp}:${idpTenant}/${idpSubject}`;
}

function parseCsvSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function getRequiredAuthValue(
  env: NodeJS.ProcessEnv,
  key: (typeof REQUIRED_AUTH_ENV_KEYS)[number],
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Incomplete authentication configuration: missing ${key}`);
  }
  return value;
}

function parseUserCacheTtl(raw: string | undefined): number {
  if (raw === undefined) return 300;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("AUTH_USER_CACHE_TTL_SECONDS must be a positive safe integer");
  }
  return value;
}

/**
 * Build the {@link AuthRuntime} from environment variables. Returns `null` only
 * when every IdP auth setting is absent, so the API can still run in the
 * non-breaking anonymous mode. Partial configuration throws to prevent auth
 * from being disabled by a missing or misspelled required setting.
 *
 * Required to enable auth: `AUTH_PROVIDER`, `AUTH_AUTHORITY`,
 * `AUTH_API_CLIENT_ID`. Optional: `AUTH_ISSUER_TEMPLATE`, `AUTH_JWKS_URI`,
 * `AUTH_BOOTSTRAP_ADMINS`, `AUTH_BOOTSTRAP_TENANTS`. Bootstrap tenants are
 * required whenever bootstrap admins are configured. `AUTH_USER_CACHE_TTL_SECONDS`
 * defaults to 300 when unset and is validated even without IdP configuration;
 * setting it alone does not enable authentication.
 *
 * `AUTH_ISSUER_TEMPLATE` / `AUTH_JWKS_URI` override the Entra-cloud defaults so
 * a self-hosted issuer (e.g. the `entra-local` emulator, whose issuer is
 * `https://localhost:8443/{tenantid}/v2.0`) can be validated without code
 * changes. `{tenantid}` is substituted per-token in the issuer template.
 */
export function loadAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuthRuntime | null {
  const userCacheTtlSeconds = parseUserCacheTtl(env.AUTH_USER_CACHE_TTL_SECONDS);
  const configuredKeys = AUTH_ENV_KEYS.filter(
    (key) => (env[key]?.trim().length ?? 0) > 0,
  );
  if (configuredKeys.length === 0) {
    return null;
  }

  const missingKeys = REQUIRED_AUTH_ENV_KEYS.filter(
    (key) => !env[key]?.trim(),
  );
  if (missingKeys.length > 0) {
    throw new Error(
      `Incomplete authentication configuration: missing ${missingKeys.join(", ")}`,
    );
  }

  const providerId = getRequiredAuthValue(env, "AUTH_PROVIDER");
  const authority = getRequiredAuthValue(env, "AUTH_AUTHORITY");
  const audience = getRequiredAuthValue(env, "AUTH_API_CLIENT_ID");

  if (providerId !== "entra") {
    throw new Error(
      `Unsupported AUTH_PROVIDER "${providerId}" (only "entra" is supported)`,
    );
  }

  const issuerTemplate = env.AUTH_ISSUER_TEMPLATE?.trim();
  const jwksUri = env.AUTH_JWKS_URI?.trim();

  const provider = new EntraIdAuthProvider({
    authority,
    audience,
    ...(issuerTemplate ? { issuerTemplate } : {}),
    ...(jwksUri ? { jwksUri } : {}),
  });
  const enricher = new ClaimsProfileEnricher();
  const bootstrapAdmins = parseCsvSet(env.AUTH_BOOTSTRAP_ADMINS);
  const bootstrapTenants = parseCsvSet(env.AUTH_BOOTSTRAP_TENANTS);

  if (bootstrapAdmins.size > 0 && bootstrapTenants.size === 0) {
    throw new Error(
      "AUTH_BOOTSTRAP_TENANTS is required when AUTH_BOOTSTRAP_ADMINS is configured",
    );
  }

  return {
    provider,
    enricher,
    bootstrapAdmins,
    bootstrapTenants,
    userCacheTtlSeconds,
  };
}
