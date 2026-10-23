// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Request, RequestHandler } from "express";
import { AuthError, isRunToken, runTokenHashPrefix, type AuthProvider } from "shared";
import type { RunTokenVerifier } from "./run-token-verifier.js";
import {
  SERVICE_KEY_HEADER,
  SERVICE_NAME_HEADER,
  type ServiceKeyVerifier,
} from "./service-principals.js";
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

/** Raised when a request carries both service-key headers and a bearer token. */
export class AmbiguousCredentialsError extends Error {
  readonly status = 400;
  readonly code = "ambiguous_credentials";

  constructor() {
    super("Send either service credentials or a bearer token, not both");
    this.name = "AmbiguousCredentialsError";
  }
}

/** Read a single-valued header, treating empty values as absent. */
function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first ? first : undefined;
}

export interface AuthMiddlewareDeps {
  getProvider: () => AuthProvider | null;
  /** Verifies `scope_rt_` bearer tokens. Absent → run tokens are rejected. */
  getRunTokenVerifier?: () => RunTokenVerifier | null;
  /** Verifies `X-Service-Name`/`X-Internal-Key`. Absent → service keys are rejected. */
  getServiceKeyVerifier?: () => ServiceKeyVerifier | null;
}

/**
 * Verify credentials before either login enrollment or cached access resolution.
 *
 * Order: public path → auth disabled (all credentials ignored) → service key
 * headers → `scope_rt_` run token → IdP bearer. Run and service callers are
 * attached as `req.principal` with an anonymous `req.user` and no `req.auth`, so
 * they never reach user enrollment or user-access resolution.
 */
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
      const serviceName = headerValue(req, SERVICE_NAME_HEADER);
      const serviceKey = headerValue(req, SERVICE_KEY_HEADER);
      if (serviceName !== undefined || serviceKey !== undefined) {
        if (req.headers.authorization !== undefined) throw new AmbiguousCredentialsError();
        const verify = deps.getServiceKeyVerifier?.() ?? null;
        if (!serviceName || !serviceKey || !verify) {
          throw new AuthError("invalid_service_key", "Invalid service credentials");
        }
        const service = verify(serviceName, serviceKey);
        req.principal = { kind: "service", name: service.name, scopes: service.scopes };
        req.user = ANONYMOUS_USER;
        console.debug(`[auth] service caller "${service.name}" ${req.method} ${req.path}`);
        next();
        return;
      }
      const token = extractBearerToken(req);
      if (token && isRunToken(token)) {
        const verify = deps.getRunTokenVerifier?.() ?? null;
        if (!verify) throw new AuthError("invalid_run_token", "Invalid run token");
        const run = await verify(token);
        req.principal = {
          kind: "run",
          requestId: run.requestId,
          runId: run.runId,
          projectId: run.projectId,
        };
        req.user = ANONYMOUS_USER;
        console.debug(
          `[auth] run caller request=${run.requestId} run=${run.runId} token=${runTokenHashPrefix(run.tokenHash)} ${req.method} ${req.path}`,
        );
        next();
        return;
      }
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
