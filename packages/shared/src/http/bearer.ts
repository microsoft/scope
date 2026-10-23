// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Returns the bearer credential a client should present to the API, or
 * `undefined` to send the request without an `Authorization` header.
 */
export type BearerProvider = () => string | undefined;

/** Build an `Authorization` header object when a bearer is available. */
export function bearerHeaders(bearer?: BearerProvider): Record<string, string> {
  const token = bearer?.();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * `fetch` that adds `Authorization: Bearer <token>` when the provider returns a
 * token. Without a token, it forwards the original arguments unchanged.
 */
export function fetchWithBearer(
  url: string,
  bearer?: BearerProvider,
  init?: RequestInit,
): Promise<Response> {
  const auth = bearerHeaders(bearer);
  if (Object.keys(auth).length === 0) {
    return init === undefined ? fetch(url) : fetch(url, init);
  }
  const base = init?.headers;
  // Keep plain-object headers plain so callers and tests see a simple record.
  const headers: HeadersInit =
    base === undefined || (typeof base === "object" && !(base instanceof Headers) && !Array.isArray(base))
      ? { ...(base as Record<string, string> | undefined), ...auth }
      : (() => {
          const merged = new Headers(base);
          merged.set("Authorization", auth.Authorization);
          return merged;
        })();
  return fetch(url, { ...init, headers });
}
