// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Single {@link PublicClientApplication} instance for the Portal.
 *
 * MSAL is created here (outside React) so non-React code — notably the API
 * transport interceptor in [`../api-client.ts`](../api-client.ts) — can acquire
 * tokens without hooks. React components use `@azure/msal-react`'s hooks against
 * this same instance via `<MsalProvider>`.
 *
 * See [docs/architecture/auth-rbac.md](../../../../../docs/architecture/auth-rbac.md) §8.
 */
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
  type AuthenticationResult,
} from "@azure/msal-browser";
import {
  authConfig,
  isAuthEnabled,
  apiTokenRequestScopes,
  buildMsalConfiguration,
  loginRequestScopes,
} from "./authConfig";

/** The shared MSAL instance backing both React hooks and the API interceptor. */
export const msalInstance = new PublicClientApplication(buildMsalConfiguration());

let initialized = false;
let initPromise: Promise<void> | undefined;

/** An actual redirect result, not a restored account or silent token refresh. */
export interface RedirectLogin {
  readonly accountKey: string;
}

let pendingRedirectLogin: RedirectLogin | undefined;

export function getAccountKey(account: AccountInfo): string {
  return JSON.stringify([
    account.homeAccountId,
    account.localAccountId,
    account.tenantId,
    account.environment,
  ]);
}

export function getPendingRedirectLogin(account: AccountInfo): RedirectLogin | undefined {
  return pendingRedirectLogin?.accountKey === getAccountKey(account)
    ? pendingRedirectLogin
    : undefined;
}

/** Consume only after Scope accepted the login; failed attempts remain retryable. */
export function consumeRedirectLogin(login: RedirectLogin): void {
  if (pendingRedirectLogin === login) pendingRedirectLogin = undefined;
}

/** An abandoned account must not leave a login event for a later session. */
export function discardRedirectLogin(accountKey: string): void {
  if (pendingRedirectLogin?.accountKey === accountKey) pendingRedirectLogin = undefined;
}

/** Pick a stable active account: the current one, else the first cached. */
function ensureActiveAccount(): AccountInfo | null {
  const active = msalInstance.getActiveAccount();
  if (active) return active;
  const [first] = msalInstance.getAllAccounts();
  if (first) {
    msalInstance.setActiveAccount(first);
    return first;
  }
  return null;
}

/**
 * Initialize MSAL and complete any in-flight redirect sign-in. Idempotent —
 * safe to call from both the bootstrap path and React effects; the underlying
 * work runs at most once.
 */
export async function initializeAuth(): Promise<void> {
  // Auth feature disabled → never touch MSAL. Keeps the bootstrap path inert so
  // the Portal behaves exactly as it did pre-auth.
  if (!isAuthEnabled) return;
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await msalInstance.initialize();
    try {
      const result = await msalInstance.handleRedirectPromise();
      if (result?.account) {
        msalInstance.setActiveAccount(result.account);
        pendingRedirectLogin = { accountKey: getAccountKey(result.account) };
      } else {
        ensureActiveAccount();
      }
    } catch (error) {
      // A stale/consumed redirect hash or a poisoned cache (e.g. left over from
      // a previous misconfiguration) must not leave MSAL wedged. Clear the auth
      // state so the app can start a clean interactive sign-in instead of
      // bricking on every reload.
      // eslint-disable-next-line no-console
      console.error("MSAL redirect handling failed; resetting auth state", error);
      await clearAuthState();
    }
    initialized = true;
  })();

  return initPromise;
}

/**
 * Remove all MSAL browser state (token cache, accounts, and the
 * `interaction_in_progress` marker that a plain refresh does NOT clear). Used to
 * recover from a wedged/poisoned auth cache. Best-effort — never throws.
 */
export async function clearAuthState(): Promise<void> {
  pendingRedirectLogin = undefined;
  try {
    await msalInstance.clearCache();
  } catch {
    // ignore — fall through to the raw storage sweep below
  }
  try {
    for (const storage of [
      window.localStorage,
      window.sessionStorage,
    ] as Storage[]) {
      for (const key of Object.keys(storage)) {
        if (key.startsWith("msal.") || key.startsWith("msal_")) {
          storage.removeItem(key);
        }
      }
    }
  } catch {
    // ignore — storage may be unavailable
  }
}

/** Start an interactive redirect sign-in. */
export async function login(): Promise<void> {
  await initializeAuth();
  await msalInstance.loginRedirect({ scopes: loginRequestScopes });
}

/** Sign out via redirect, clearing the cached account. */
export async function logout(): Promise<void> {
  await initializeAuth();
  pendingRedirectLogin = undefined;
  await msalInstance.logoutRedirect({
    account: msalInstance.getActiveAccount() ?? undefined,
  });
}

/**
 * Acquire an API access token silently.
 *
 * Returns the raw bearer token, or `undefined` when there is no signed-in
 * account or silent acquisition needs user interaction. The caller (the API
 * interceptor / route guard) decides whether to trigger an interactive
 * redirect — this function never redirects on its own so it is safe to call on
 * every outgoing request.
 */
export async function acquireApiToken(
  options: { forceRefresh?: boolean } = {},
): Promise<string | undefined> {
  await initializeAuth();
  const account = ensureActiveAccount();
  if (!account) return undefined;

  try {
    const result: AuthenticationResult = await msalInstance.acquireTokenSilent({
      account,
      scopes: apiTokenRequestScopes,
      forceRefresh: options.forceRefresh ?? false,
    });
    return result.accessToken || undefined;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) return undefined;
    // Re-throw unexpected errors so they surface rather than silently
    // dropping the Authorization header on a transient failure.
    throw error;
  }
}

/** Trigger an interactive redirect to (re)acquire a token for the API scopes. */
export async function acquireApiTokenRedirect(): Promise<void> {
  await initializeAuth();
  await msalInstance.acquireTokenRedirect({ scopes: apiTokenRequestScopes });
}

/** Whether a Portal auth config was resolved (see {@link authConfig}). */
export const isAuthConfigured = authConfig.isConfigured;

/**
 * Whether the auth feature is turned on for this build. Re-exported from
 * {@link authConfig} so auth consumers (route guard, API wiring, header UI) have
 * a single import surface. See `isAuthEnabled` in `authConfig.ts`.
 */
export { isAuthEnabled };
