// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Portal authentication configuration (Microsoft Entra ID via MSAL).
 *
 * Per the auth spec ([docs/architecture/auth-rbac.md](../../../../../docs/architecture/auth-rbac.md)
 * §8, subtask 10) the Portal's IdP config is **build-time** configuration, not
 * fetched from the API. It is read from `VITE_AUTH_*` environment variables so
 * retargeting the IdP (local `entra-local` emulator vs. production Entra ID) is
 * a config change, mirroring the CLI.
 *
 * In `dev` builds the values default to the deterministic seed directory shipped
 * by [entra-local](https://github.com/cmaneu/entra-local) (tag `v0.0.3`) so
 * sign-in works out of the box after the emulator is running. The dev emulator
 * serves **HTTPS** using a locally-trusted mkcert certificate (provisioned by
 * `scripts/ensure-dev-certs.sh`), so no manual certificate trust is required —
 * MSAL requires an https authority. Under Docker the compose stack injects
 * `VITE_AUTH_AUTHORITY` / `VITE_AUTH_KNOWN_AUTHORITIES` with the per-worktree
 * host port, overriding these defaults. Production builds **must** supply the
 * `VITE_AUTH_*` values (baked into the bundle at build time); when they are
 * missing the config is reported as not configured so the app can surface a
 * clear error instead of silently pointing at `localhost`.
 *
 * Only **Entra** is wired today. The shape mirrors the shared `AuthClientConfig`
 * so adding another IdP later is a config + provider change, not a call-site one.
 */
import {
  LogLevel,
  ProtocolMode as MsalProtocolMode,
  type Configuration,
} from "@azure/msal-browser";

export type ProtocolMode = "AAD" | "OIDC";

/** Portal-facing view of the resolved auth configuration. */
export interface PortalAuthConfig {
  clientId: string;
  authority: string;
  knownAuthorities: string[];
  /** Scopes requested for the API access token. */
  scopes: string[];
  redirectUri: string;
  postLogoutRedirectUri: string;
  protocolMode: ProtocolMode;
  /** Where MSAL persists its token cache. */
  cacheLocation: "localStorage" | "sessionStorage";
  /**
   * Primary switch: `true` when the auth feature is turned on for this build.
   *
   * Auth is **on by default (secure by default)** and only turns off when an
   * environment explicitly opts out. There are three independent per-environment
   * controls (see {@link resolveAuthEnabled}):
   *  - **local dev** — `VITE_AUTH_ENABLED_LOCAL` (build-time).
   *  - **integration** — `SCOPE_AUTH_ENABLED` on the integration overlay
   *    (runtime, via `/config.js` → `window.__SCOPE_CONFIG__.authEnabled`).
   *  - **production** — `SCOPE_AUTH_ENABLED` on the prod overlay (same runtime
   *    mechanism). int/prod must be runtime because the image is promoted.
   *
   * When `false`, the Portal renders exactly as it did before auth existed: no
   * sign-in gate, no account menu, and no `Authorization` header on API calls.
   * This is the toggle to use until an environment's API ships token verification.
   */
  enabled: boolean;
  /**
   * `true` when a usable configuration was resolved. In production this requires
   * the `VITE_AUTH_*` env vars to be present at build time.
   */
  isConfigured: boolean;
}

/** entra-local (`0.0.3`) seeded directory — used as dev-only defaults. */
const ENTRA_LOCAL_DEFAULTS = {
  /**
   * Seeded public SPA app registration ("Sample SPA"). entra-local uses the
   * app's object id as the client id; this is the value the emulator seeds and
   * exposes at `/admin/api/apps`. The dev Portal origin is auto-registered as a
   * redirect URI on this app by the `entra-local-init` compose service.
   */
  clientId: "cccccccc-0000-0000-0000-000000000001",
  /** Seeded fixed tenant, OIDC v2.0 authority served over local HTTPS. */
  authority: "https://localhost:8443/11111111-1111-1111-1111-111111111111/v2.0",
  /** Custom (non-Microsoft) authority host must be allow-listed for MSAL. */
  knownAuthorities: ["localhost:8443"],
  /**
   * Fully-qualified scope for the seeded API app's exposed `access_as_user`
   * scope. MSAL needs the resource-qualified form (`api://<appId>/<scope>`) to
   * resolve the API access token's audience.
   */
  scopes: ["api://cccccccc-0000-0000-0000-000000000005/access_as_user"],
  /** entra-local speaks generic OIDC, not the AAD-specific protocol. */
  protocolMode: "OIDC" as ProtocolMode,
};

function envList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * Parse a boolean-ish env var. Accepts `true/1/yes/on` and `false/0/no/off`
 * (case-insensitive); anything else (including undefined/empty) yields
 * `fallback`, so a mis-set value fails safe to the default rather than silently
 * disabling auth.
 */
function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * Resolve whether the auth feature is enabled for the current environment.
 *
 * There are **three independent, per-environment controls** (local, integration,
 * production). Auth is **on by default** (secure by default); a control must
 * explicitly opt out. Because the production Portal image is **built once and
 * promoted** int→prod (see the overlay `images.yaml` files + `promote.yml`), a
 * build-time `VITE_` flag cannot differ between integration and production — so
 * int/prod are governed at **runtime** while local uses a build-time flag:
 *
 *  1. **integration / production** — `window.__SCOPE_CONFIG__.authEnabled`,
 *     written into `/config.js` at container start by
 *     `apps/portal/docker-entrypoint.sh` from the `SCOPE_AUTH_ENABLED` env var
 *     (set per environment via the portal's container env).
 *     This runtime value wins whenever present, so the single promoted bundle
 *     obeys each environment's own setting.
 *  2. **local dev** — `VITE_AUTH_ENABLED_LOCAL` (build-time, read by `vite dev`).
 *     Local `/config.js` ships no `authEnabled`, so resolution falls through to
 *     this flag. `false` disables auth for local iteration without standing up
 *     `entra-local`.
 *  3. **fallback** — a built bundle served without the entrypoint (no runtime
 *     `authEnabled`) defaults to enabled, so a misconfigured deploy fails safe
 *     to secured rather than open.
 */
export function resolveAuthEnabled(
  runtime: ScopeRuntimeConfig | undefined,
  env: ImportMetaEnv,
  isDev: boolean,
): boolean {
  // 1) Per-environment runtime override (integration/production).
  const runtimeValue = runtime?.authEnabled;
  if (typeof runtimeValue === "boolean") return runtimeValue;
  if (typeof runtimeValue === "string") return envBool(runtimeValue, true);
  // 2) Local dev build-time flag.
  if (isDev) {
    return envBool(env.VITE_AUTH_ENABLED_LOCAL as string | undefined, true);
  }
  // 3) Built bundle, no runtime config → secure default.
  return true;
}

function resolveConfig(): PortalAuthConfig {
  const env = import.meta.env;
  const isDev = Boolean(env.DEV);
  const runtime =
    typeof window !== "undefined" ? window.__SCOPE_CONFIG__ : undefined;
  const enabled = resolveAuthEnabled(runtime, env, isDev);

  const clientId =
    (env.VITE_AUTH_CLIENT_ID as string | undefined) ??
    (isDev ? ENTRA_LOCAL_DEFAULTS.clientId : "");
  const authority =
    (env.VITE_AUTH_AUTHORITY as string | undefined) ??
    (isDev ? ENTRA_LOCAL_DEFAULTS.authority : "");
  const knownAuthorities =
    envList(env.VITE_AUTH_KNOWN_AUTHORITIES as string | undefined) ??
    (isDev ? ENTRA_LOCAL_DEFAULTS.knownAuthorities : []);
  const scopes =
    envList(env.VITE_AUTH_SCOPES as string | undefined) ??
    (isDev ? ENTRA_LOCAL_DEFAULTS.scopes : []);
  const protocolMode =
    (env.VITE_AUTH_PROTOCOL_MODE as ProtocolMode | undefined) ||
    (isDev ? ENTRA_LOCAL_DEFAULTS.protocolMode : "AAD");

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const redirectUri =
    (env.VITE_AUTH_REDIRECT_URI as string | undefined) || origin;
  const postLogoutRedirectUri =
    (env.VITE_AUTH_POST_LOGOUT_REDIRECT_URI as string | undefined) || origin;

  const cacheLocation =
    (env.VITE_AUTH_CACHE_LOCATION as
      | "localStorage"
      | "sessionStorage"
      | undefined) || "localStorage";

  return {
    clientId,
    authority,
    knownAuthorities,
    scopes,
    redirectUri,
    postLogoutRedirectUri,
    protocolMode,
    cacheLocation,
    enabled,
    isConfigured: Boolean(clientId && authority),
  };
}

/** The resolved Portal auth configuration (evaluated once at module load). */
export const authConfig: PortalAuthConfig = resolveConfig();

/**
 * Whether the auth feature is turned on for this build (the two-flag opt-out
 * resolution — see {@link resolveAuthEnabled}). When `false` the Portal skips
 * MSAL entirely: no sign-in gate, no account menu, no bearer token on API
 * calls. **On by default.**
 */
export const isAuthEnabled: boolean = authConfig.enabled;

/** Scopes requested when acquiring an API access token. */
export const apiTokenRequestScopes: string[] = authConfig.scopes;

/**
 * Scopes requested at interactive login. `openid`/`profile` yield an ID token
 * with the identity claims the UI displays; the API scopes are added so the
 * first silent acquisition has a cached access token to return.
 */
export const loginRequestScopes: string[] = [
  "openid",
  "profile",
  ...authConfig.scopes,
];

/** Build the MSAL browser {@link Configuration} from {@link authConfig}. */
export function buildMsalConfiguration(): Configuration {
  return {
    auth: {
      clientId: authConfig.clientId,
      authority: authConfig.authority,
      knownAuthorities: authConfig.knownAuthorities,
      redirectUri: authConfig.redirectUri,
      postLogoutRedirectUri: authConfig.postLogoutRedirectUri,
    },
    cache: {
      cacheLocation: authConfig.cacheLocation,
    },
    system: {
      // entra-local speaks generic OIDC; production Entra uses the AAD protocol.
      // In msal-browser v5 this lives under `system`, not `auth`.
      protocolMode:
        authConfig.protocolMode === "OIDC"
          ? MsalProtocolMode.OIDC
          : MsalProtocolMode.AAD,
      loggerOptions: {
        logLevel: import.meta.env.DEV ? LogLevel.Warning : LogLevel.Error,
        piiLoggingEnabled: false,
        loggerCallback: (level, message, containsPii) => {
          if (containsPii) return;
          // eslint-disable-next-line no-console
          if (level === LogLevel.Error) console.error(message);
          else if (level === LogLevel.Warning) console.warn(message);
        },
      },
    },
  };
}
