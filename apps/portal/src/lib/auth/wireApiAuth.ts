// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Connects the framework-free API transport ([`../api-client.ts`](../api-client.ts))
 * to MSAL ([`./msalInstance.ts`](./msalInstance.ts)).
 *
 * Kept separate from `api-client.ts` so that module stays free of MSAL (and thus
 * unit-testable without a browser). Call {@link wireApiAuth} once at bootstrap,
 * before initialization and the first render. Token acquisition itself waits
 * for {@link initializeAuth}.
 */
import { setApiTokenProvider, setReauthHandler } from "../api-client";
import { acquireApiToken, acquireApiTokenRedirect, isAuthEnabled } from "./msalInstance";

let wired = false;

/**
 * Wire the API transport's auth seams to MSAL:
 *  - the token provider acquires an access token silently (forcing a refresh on
 *    the `401` retry path),
 *  - the re-auth handler triggers an interactive redirect when a `401` survives
 *    the forced-refresh retry.
 *
 * No-op when the auth feature is disabled ({@link isAuthEnabled} is `false`) so
 * requests go out without an `Authorization` header and a `401` never triggers
 * an interactive redirect — preserving anonymous rollout mode.
 *
 * The token provider must never await the Scope user handshake: that handshake
 * uses this very transport. AuthProvider/RequireAuth gate application queries.
 *
 * Idempotent.
 */
export function wireApiAuth(): void {
  if (wired) return;
  if (!isAuthEnabled) return;
  wired = true;

  setApiTokenProvider((options) =>
    acquireApiToken({ forceRefresh: options?.forceRefresh }),
  );
  setReauthHandler(() => acquireApiTokenRedirect());
}
