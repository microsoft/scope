// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared helper for acquiring a GitHub public-API token.
 *
 * Used for read-only access to the GitHub REST API (skill discovery / resolution).
 * Any valid GitHub bearer token can hit public-repo endpoints, so we treat this
 * as a separate, broader capability than `github-models` / `copilot-*`.
 *
 * Priority:
 *   1. TokenManagerClient acquire("github-public-api") via TOKEN_MANAGER_URL
 *      (the client itself falls back to GITHUB_TOKEN env var first if set,
 *      see KEY_CAPABILITY_ENV_VARS).
 *   2. GITHUB_TOKEN env var (bare fallback when no token manager configured).
 *   3. `undefined` — request will be sent unauthenticated (60 req/hr limit).
 *
 * Mirrors the pattern in llm-token.ts.
 */
import { TokenManagerClient } from "@scope/secrets";

let tokenManagerClient: TokenManagerClient | null = null;

function getTokenManagerClient(): TokenManagerClient | null {
  if (tokenManagerClient) return tokenManagerClient;
  const url = process.env.TOKEN_MANAGER_URL;
  if (!url) return null;
  tokenManagerClient = new TokenManagerClient(url);
  return tokenManagerClient;
}

/**
 * Acquire a GitHub token suitable for public-repo REST API calls.
 *
 * Returns `undefined` (rather than throwing) if no token is available, so the
 * caller can decide whether to attempt an unauthenticated request or surface
 * a friendlier error.
 */
export async function acquireGitHubPublicApiToken(): Promise<string | undefined> {
  // 1. Token Manager (handles its own GITHUB_TOKEN fallback internally)
  const client = getTokenManagerClient();
  if (client) {
    try {
      return await client.acquireToken("github-public-api");
    } catch {
      // Fall through — token manager has no registered tokens for this
      // capability AND no env-var fallback was set. Try the bare env var.
    }
  }

  // 2. Bare GITHUB_TOKEN fallback (no token manager)
  const fallback = process.env.GITHUB_TOKEN;
  if (fallback) return fallback;

  // 3. Unauthenticated — caller will hit GitHub's anonymous rate limit.
  return undefined;
}
