// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ClaimsProfileEnricher } from "./claims-enricher.js";
import { EntraIdAuthProvider } from "./entra.js";
import type { AuthProvider, ProfileEnricher } from "./types.js";
import { resolveAuthEnabledFlag } from "../rbac.js";

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
  /** Fixed lifetime of an active Scope-user cache entry. */
  userCacheTtlSeconds: number;
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
 * when SCOPE_AUTH_ENABLED explicitly disables authentication and RBAC.
 * Missing or partial IdP configuration otherwise throws rather than opening access.
 *
 * Required to enable auth: `AUTH_PROVIDER`, `AUTH_AUTHORITY`,
 * `AUTH_API_CLIENT_ID`. Optional: `AUTH_ISSUER_TEMPLATE`, `AUTH_JWKS_URI`,
 * `AUTH_USER_CACHE_TTL_SECONDS`
 * defaults to 300 when unset. IdP settings are unused when auth is disabled.
 *
 * `AUTH_ISSUER_TEMPLATE` / `AUTH_JWKS_URI` override the Entra-cloud defaults so
 * a self-hosted issuer (e.g. the `entra-local` emulator, whose issuer is
 * `https://localhost:8443/{tenantid}/v2.0`) can be validated without code
 * changes. `{tenantid}` is substituted per-token in the issuer template.
 */
export function loadAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuthRuntime | null {
  if (!resolveAuthEnabledFlag(env.SCOPE_AUTH_ENABLED)) return null;
  if (env.AUTH_BOOTSTRAP_ADMINS?.trim() || env.AUTH_BOOTSTRAP_TENANTS?.trim()) {
    throw new Error("AUTH_BOOTSTRAP_ADMINS/AUTH_BOOTSTRAP_TENANTS are retired. Remove them and use the operator bootstrap-admin script after genuine enrollment.");
  }
  const userCacheTtlSeconds = parseUserCacheTtl(env.AUTH_USER_CACHE_TTL_SECONDS);
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
  return {
    provider,
    enricher,
    userCacheTtlSeconds,
  };
}
