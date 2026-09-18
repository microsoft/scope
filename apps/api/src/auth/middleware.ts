// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Request, RequestHandler } from "express";
import { AuthError, type AuthProvider } from "shared";
import { ANONYMOUS_USER } from "./types.js";
import type { UserAccessService } from "./user-access-resolver.js";

const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/health",
  "/ready",
  "/about",
  "/api/v1/version",
  "/openapi.json",
]);

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) ||
    path === "/api-docs" || path.startsWith("/api-docs/");
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) throw new AuthError("invalid_token", "Malformed bearer header");
  return match[1];
}

export interface AuthMiddlewareDeps {
  getProvider: () => AuthProvider | null;
}

/** Verify credentials before either login enrollment or cached access resolution. */
export function createAuthMiddleware(deps: AuthMiddlewareDeps): RequestHandler {
  return async (req, _res, next): Promise<void> => {
    try {
      if (isPublicPath(req.path)) {
        next();
        return;
      }
      const provider = deps.getProvider();
      if (!provider) {
        req.user = ANONYMOUS_USER;
        next();
        return;
      }
      const token = extractBearerToken(req);
      if (!token) {
        req.user = ANONYMOUS_USER;
        next();
        return;
      }
      const identity = await provider.verifyAccessToken(token);
      req.auth = { identity, token };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Mounted after /users/me: normal requests may resolve, but never enroll, a user. */
export function createUserAccessMiddleware(
  getResolver: () => UserAccessService | null,
): RequestHandler {
  return async (req, _res, next): Promise<void> => {
    try {
      if (!req.auth) {
        next();
        return;
      }
      const resolver = getResolver();
      if (!resolver) {
        throw new AuthError("service_unavailable", "Authentication service unavailable");
      }
      req.user = await resolver.resolveExisting(req.auth.identity);
      next();
    } catch (err) {
      next(err);
    }
  };
}
