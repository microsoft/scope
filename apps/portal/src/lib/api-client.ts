// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared HTTP transport for the Portal, built on
 * [`ky`](https://github.com/sindresorhus/ky).
 *
 * The Portal's API facade ({@link file://./api.ts}) and blob-fetching hooks talk
 * to the Scope API through this single {@link apiClient} instance instead of
 * calling `fetch` directly. Centralizing the transport gives us one place to:
 *  - inject `Authorization: Bearer` via the pluggable {@link setApiTokenProvider}
 *    seam (wired to MSAL in [`./auth/wireApiAuth.ts`](./auth/wireApiAuth.ts)),
 *  - handle `401` centrally: force a silent token refresh and retry once, then
 *    fall back to interactive re-auth via the {@link setReauthHandler} seam,
 *  - later opt into request logging.
 *
 * The instance mirrors the CLI client's configuration: it never throws on
 * non-2xx (`throwHttpErrors: false`) so call sites keep their existing
 * `response.ok` handling and has no client-side timeout. The **only** retry it
 * performs is a single, auth-scoped retry on `401` (see below) — it does **not**
 * retry transient `429`/`503`s, so it never stacks with the shared cockatiel
 * `withRetry`/`@Retry` (packages/shared/src/utils/retry.ts).
 *
 * Auth is kept out of this module so it stays framework-free and unit-testable:
 * MSAL is wired in through the {@link setApiTokenProvider}/{@link setReauthHandler}
 * seams, not imported here.
 *
 * The root-level `/ready` health probe (`api.getReadiness`) intentionally keeps
 * using `fetch` directly: it is unauthenticated, lives outside `/api/v1`, and
 * needs bespoke `503` handling.
 *
 * See [docs/architecture/auth-rbac.md](../../../../docs/architecture/auth-rbac.md) §7/§8.
 */
import ky, {
  type AfterResponseHook,
  type BeforeRequestHook,
  type BeforeRetryHook,
  type KyInstance,
} from "ky";

/** Options passed to a {@link TokenProvider}. */
export interface TokenRequestOptions {
  /** Bypass the token cache and force a fresh token (used on `401` retry). */
  forceRefresh?: boolean;
}

/**
 * Resolves the bearer token to attach to outgoing Scope API requests. Returning
 * `undefined` means "no token available" — the request goes out unauthenticated.
 */
export type TokenProvider = (
  options?: TokenRequestOptions,
) => string | undefined | Promise<string | undefined>;

/**
 * Invoked when a request is rejected with `401` even after a forced token
 * refresh + retry. Typically triggers an interactive re-login redirect.
 */
export type ReauthHandler = () => void | Promise<void>;

const noopTokenProvider: TokenProvider = () => undefined;
const noopReauthHandler: ReauthHandler = () => {};

// Portal auth defaults to no token / no re-auth. It is wired to MSAL at
// bootstrap via wireApiAuth(); until then requests go out unauthenticated.
let tokenProvider: TokenProvider = noopTokenProvider;
let reauthHandler: ReauthHandler = noopReauthHandler;
let sessionSignal: AbortSignal | undefined;

/** Cancel every account-bound request, even query functions without a signal. */
export function setApiSessionSignal(signal: AbortSignal | undefined): void {
  sessionSignal = signal;
}

/** Override how bearer tokens are resolved (wired by Portal auth). */
export function setApiTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

/** Override what happens when re-auth is required after a `401` (wired by Portal auth). */
export function setReauthHandler(handler: ReauthHandler): void {
  reauthHandler = handler;
}

/** Reset the auth seams to their defaults. Primarily for tests. */
export function resetApiClient(): void {
  tokenProvider = noopTokenProvider;
  reauthHandler = noopReauthHandler;
  sessionSignal = undefined;
}

const authHook: BeforeRequestHook = async ({ request }) => {
  const signal = sessionSignal
    ? AbortSignal.any([request.signal, sessionSignal])
    : request.signal;
  signal.throwIfAborted();
  if (!request.headers.has("authorization")) {
    const token = await tokenProvider();
    if (token) request.headers.set("authorization", `Bearer ${token}`);
  }
  signal.throwIfAborted();
  return new Request(request, { signal });
};

// On a 401, force a fresh token so ky retries the request with it. ky owns
// request/body reconstruction for the retry, so this is safe for POSTs. The
// mutated request is returned so ky retries with the refreshed header.
const reauthRetryHook: BeforeRetryHook = async ({ request }) => {
  request.signal.throwIfAborted();
  const token = await tokenProvider({ forceRefresh: true });
  request.signal.throwIfAborted();
  if (token) request.headers.set("authorization", `Bearer ${token}`);
  return request;
};

// Centralized 401 handling. Because `throwHttpErrors` is disabled, ky's
// status-code retry never fires, so we drive the retry ourselves from
// afterResponse via `ky.retry()` (a forced retry that still respects
// `retry.limit`). Flow:
//   - first 401 (retryCount === 0): force one retry; `reauthRetryHook` then
//     force-refreshes the token before the second attempt.
//   - 401 after the retry (retryCount > 0): give up and hand off to the
//     interactive re-auth handler (redirect), returning the 401 to the caller.
const handle401Hook: AfterResponseHook = async ({ request, response, retryCount }) => {
  request.signal.throwIfAborted();
  if (response.status !== 401) return response;
  if (retryCount === 0) {
    return ky.retry({ delay: 0 });
  }
  await reauthHandler();
  return response;
};

/** Shared `ky` instance backing the Portal API facade and blob fetches. */
export const apiClient: KyInstance = ky.create({
  // Call sites do their own `response.ok` handling — never throw on non-2xx.
  throwHttpErrors: false,
  // No client-side timeout; cancellation is handled per-request via `signal`.
  timeout: false,
  // The ONLY retry we do is a single auth-scoped retry on 401, driven from the
  // afterResponse hook via `ky.retry()`: force a fresh token and try once more
  // before falling back to interactive re-auth. `limit: 1` caps it at a single
  // retry. We do NOT retry transient 429/503s here — that stays with the shared
  // cockatiel `withRetry`/`@Retry`, so the two layers never compound.
  retry: {
    limit: 1,
    // Forced ky.retry() on 401 bypasses this. Network failures must not replay
    // an enrollment POST whose database write may already have succeeded.
    shouldRetry: () => false,
  },
  hooks: {
    beforeRequest: [authHook],
    beforeRetry: [reauthRetryHook],
    afterResponse: [handle401Hook],
  },
});
