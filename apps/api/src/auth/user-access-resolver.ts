// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  MongoNetworkError,
  MongoNotConnectedError,
  MongoOperationTimeoutError,
  MongoServerClosedError,
  MongoServerError,
  MongoServerSelectionError,
  MongoTopologyClosedError,
} from "mongodb";
import type { ProfileEnricher, UserDocument, UserProfile, VerifiedIdentity } from "shared";
import type { AuthenticatedUser } from "./types.js";
import { isActiveUserAccess, type UserAccessCache } from "./user-access-cache.js";
import type { UserStore } from "./user-store.js";

const ACCESS_ERRORS = {
  user_not_enrolled: { status: 403, message: "User is not enrolled" },
  user_disabled: { status: 403, message: "User is disabled" },
  invalid_principal: { status: 401, message: "Invalid user principal" },
  service_unavailable: { status: 503, message: "Authentication service unavailable" },
} as const;

export type UserAccessErrorCode = keyof typeof ACCESS_ERRORS;

export class UserAccessError extends Error {
  readonly status: 401 | 403 | 503;

  constructor(readonly code: UserAccessErrorCode, message: string = ACCESS_ERRORS[code].message) {
    super(message);
    this.name = "UserAccessError";
    this.status = ACCESS_ERRORS[code].status;
  }
}

export interface UserAccessResolverOptions {
  userStore: Pick<UserStore, "findByIdentity" | "upsertOnLogin">;
  cache: UserAccessCache;
  enricher: ProfileEnricher | null;
}

/** Structural seam for middleware/routes and test doubles. */
export interface UserAccessService {
  resolveExisting(identity: VerifiedIdentity): Promise<AuthenticatedUser>;
  enrollOnLogin(identity: VerifiedIdentity, rawToken: string): Promise<AuthenticatedUser>;
}

const CONNECTIVITY_ERROR_CODES = new Set([
  6, 7, 89, 91, 189, 9001, 10107, 11600, 11602, 13435, 13436,
]);

function isMongoUnavailable(error: unknown): boolean {
  return error instanceof MongoNetworkError ||
    error instanceof MongoServerSelectionError ||
    error instanceof MongoNotConnectedError ||
    error instanceof MongoTopologyClosedError ||
    error instanceof MongoServerClosedError ||
    error instanceof MongoOperationTimeoutError ||
    (error instanceof MongoServerError && typeof error.code === "number" &&
      CONNECTIVITY_ERROR_CODES.has(error.code));
}

export class UserAccessResolver implements UserAccessService {
  constructor(private readonly options: UserAccessResolverOptions) {}

  async resolveExisting(identity: VerifiedIdentity): Promise<AuthenticatedUser> {
    const cached = await this.options.cache.get(identity);
    if (cached.status === "hit") return cached.user;
    const user = await this.readStore(() => this.options.userStore.findByIdentity(identity));
    return this.validateAndWarm(identity, user);
  }

  async enrollOnLogin(identity: VerifiedIdentity, rawToken: string): Promise<AuthenticatedUser> {
    const profile: UserProfile = this.options.enricher
      ? await this.options.enricher.enrich(identity, rawToken)
      : {
        email: identity.email,
        displayName: identity.displayName,
        emailVerified: identity.emailVerified,
      };
    const user = await this.readStore(() => this.options.userStore.upsertOnLogin(identity, profile));
    return this.validateAndWarm(identity, user);
  }

  private async readStore(operation: () => Promise<UserDocument | null>): Promise<UserDocument | null> {
    try {
      return await operation();
    } catch (error) {
      if (!isMongoUnavailable(error)) throw error;
      throw new UserAccessError("service_unavailable");
    }
  }

  private async validateAndWarm(
    identity: VerifiedIdentity,
    user: UserDocument | null,
  ): Promise<AuthenticatedUser> {
    let error: UserAccessError | undefined;
    let principal: AuthenticatedUser | undefined;
    if (!user) {
      error = new UserAccessError("user_not_enrolled");
    } else {
      principal = {
        id: user._id,
        role: user.role,
        isAuthenticated: true,
        isService: false,
        idp: user.idp,
        idpTenant: user.idpTenant,
        idpSubject: user.idpSubject,
        ...(user.email !== undefined ? { email: user.email } : {}),
        ...(user.displayName !== undefined ? { displayName: user.displayName } : {}),
      };
      if (!isActiveUserAccess(identity, principal)) {
        error = new UserAccessError("invalid_principal");
      } else if (user.disabledAt) {
        error = new UserAccessError("user_disabled");
      }
    }
    if (error || !principal) {
      await this.options.cache.delete(identity);
      throw error ?? new UserAccessError("invalid_principal");
    }
    await this.options.cache.set(identity, principal);
    return principal;
  }
}
