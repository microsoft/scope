/// <reference types="vite/client" />

// Build-time version info (injected via vite.config.ts define)
declare const __GIT_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __GIT_BRANCH__: string;

interface ImportMetaEnv {
  /** Show the Pass@k metrics table on the Statistics page (default: hidden) */
  readonly VITE_SHOW_PASS_AT_K?: string;
  /**
   * Local-dev-only opt-out for the auth feature. Set to `"false"` to disable
   * sign-in for `vite dev` builds only. Integration/production are controlled at
   * runtime via `SCOPE_AUTH_ENABLED` (see `ScopeRuntimeConfig.authEnabled`),
   * because the built image is promoted int→prod. Auth is ON by default.
   * See apps/portal/src/lib/auth/authConfig.ts.
   */
  readonly VITE_AUTH_ENABLED_LOCAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Runtime configuration injected via /config.js before the app boots. */
interface ScopeRuntimeConfig {
  /** Base URL for the public docs site (no trailing slash required). */
  docsBaseUrl?: string;
  /**
   * Per-environment auth feature switch for **integration/production**, written
   * into `/config.js` at container start by `apps/portal/docker-entrypoint.sh`
   * from the `SCOPE_AUTH_ENABLED` env var (set per deploy overlay). Absent in
   * local dev, where the build-time `VITE_AUTH_ENABLED_LOCAL` flag applies
   * instead. When present it takes precedence. Auth is ON by default.
   */
  authEnabled?: boolean;
  /** Public OAuth client ID supplied by SCOPE_AUTH_CLIENT_ID at container start. */
  authClientId?: string;
  /** Entra authority supplied by SCOPE_AUTH_AUTHORITY at container start. */
  authAuthority?: string;
  /** Comma-separated API scopes supplied by SCOPE_AUTH_SCOPES at container start. */
  authScopes?: string;
}

interface Window {
  __SCOPE_CONFIG__?: ScopeRuntimeConfig;
}
