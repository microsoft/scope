// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Runtime configuration for the portal.
//
// In production this file is regenerated at container start by
// docker-entrypoint.sh from environment variables (SCOPE_DOCS_BASE_URL,
// SCOPE_AUTH_ENABLED, SCOPE_AUTH_CLIENT_ID, SCOPE_AUTH_AUTHORITY,
// SCOPE_AUTH_SCOPES), so public auth settings can change per environment.
//
// In development (Vite) this static file is served as-is and provides the
// default values. Note: `authEnabled` is intentionally omitted here so local
// dev falls through to the build-time `VITE_AUTH_ENABLED_LOCAL` flag (see
// src/lib/auth/authConfig.ts). Keep the shape in sync with the
// `Window.__SCOPE_CONFIG__` declaration in src/vite-env.d.ts.
window.__SCOPE_CONFIG__ = Object.assign(
  { docsBaseUrl: "https://urban-disco-1qzzq7z.pages.github.io" },
  window.__SCOPE_CONFIG__,
);
