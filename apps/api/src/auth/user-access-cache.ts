// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Redis } from "ioredis";
import { z } from "zod";
import {
  ANONYMOUS_USER_ID,
  SYSTEM_USER_ID,
  type RedisConfig,
  type VerifiedIdentity,
} from "shared";
import type { AuthenticatedUser } from "./types.js";

export type UserAccessCacheResult =
  | { status: "hit"; user: AuthenticatedUser }
  | { status: "miss" }
  | { status: "unavailable" };

export type UserAccessCacheWriteResult = { status: "ok" | "unavailable" };

/** Expected backend failures are logged by the adapter, not thrown or treated as misses. */
export interface UserAccessCache {
  get(identity: VerifiedIdentity): Promise<UserAccessCacheResult>;
  set(identity: VerifiedIdentity, user: AuthenticatedUser): Promise<UserAccessCacheWriteResult>;
  delete(identity: VerifiedIdentity): Promise<UserAccessCacheWriteResult>;
  close(): Promise<void>;
}

export interface RedisUserAccessCacheOptions {
  ttlSeconds: number;
  /** Scope MongoDB database name; isolates independent deployments sharing Redis. */
  namespace: string;
}

const SnapshotSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).refine((id) => id !== SYSTEM_USER_ID && id !== ANONYMOUS_USER_ID),
  role: z.string().min(1),
  idp: z.string().min(1),
  idpTenant: z.string().min(1),
  idpSubject: z.string().min(1),
  email: z.string().optional(),
  displayName: z.string().optional(),
}).strict();

type Snapshot = z.infer<typeof SnapshotSchema>;
type RedisResult<T> = { status: "ok"; value: T } | { status: "unavailable" };

const LOG_INTERVAL_MS = 60_000;
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT",
  "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

function isExpectedRedisError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code: unknown = "code" in error ? error.code : undefined;
  return (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) ||
    error.name === "ReplyError" ||
    error.name === "MaxRetriesPerRequestError" ||
    error.message === "Command timed out" ||
    /^Socket timeout\. Expecting data, but didn't receive any in [0-9]+ms\.$/.test(error.message) ||
    error.message === "Connection is closed." ||
    error.message === "Stream isn't writeable and enableOfflineQueue options is false";
}

function matchesIdentity(snapshot: Snapshot, identity: VerifiedIdentity): boolean {
  return snapshot.idp === identity.idp &&
    snapshot.idpTenant === identity.idpTenant &&
    snapshot.idpSubject === identity.idpSubject;
}

function snapshotFor(user: AuthenticatedUser): unknown {
  return {
    version: 1,
    id: user.id,
    role: user.role,
    idp: user.idp,
    idpTenant: user.idpTenant,
    idpSubject: user.idpSubject,
    ...(user.email !== undefined ? { email: user.email } : {}),
    ...(user.displayName !== undefined ? { displayName: user.displayName } : {}),
  };
}

/** The cache accepts only active human principals matching the verified identity. */
export function isActiveUserAccess(identity: VerifiedIdentity, user: AuthenticatedUser): boolean {
  if (user.isAuthenticated !== true || (user.isService !== undefined && user.isService !== false)) {
    return false;
  }
  const parsed = SnapshotSchema.safeParse(snapshotFor(user));
  return parsed.success && matchesIdentity(parsed.data, identity);
}

export function userAccessCacheKey(namespace: string, identity: VerifiedIdentity): string {
  return `auth-user:v1:${[namespace, identity.idp, identity.idpTenant, identity.idpSubject]
    .map((part) => encodeURIComponent(part)).join(":")}`;
}

/**
 * A blank Redis host creates no client: every operation reports unavailable and
 * the resolver uses MongoDB. There is deliberately no process-local fallback cache.
 */
export class RedisUserAccessCache implements UserAccessCache {
  private readonly redis: Redis | null;
  private closed = false;
  private unavailable = false;
  private lastUnavailableLog = -Infinity;
  private lastInvalidEntryLog = -Infinity;
  private lastRecoveryLog = -Infinity;

  constructor(
    config: RedisConfig,
    private readonly options: RedisUserAccessCacheOptions,
  ) {
    if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new Error("User access cache TTL must be a positive safe integer");
    }
    if (!options.namespace.trim()) {
      throw new Error("User access cache namespace must not be empty");
    }
    if (!config.redisHost.trim()) {
      this.redis = null;
      this.warnUnavailable();
      return;
    }

    const useTls = process.env.REDIS_TLS !== undefined
      ? process.env.REDIS_TLS === "true"
      : Boolean(config.redisPassword &&
        !["localhost", "127.0.0.1", "redis"].includes(config.redisHost));
    this.redis = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      password: config.redisPassword || undefined,
      ...(useTls ? { tls: {} } : {}),
      connectTimeout: 1_000,
      commandTimeout: 500,
      socketTimeout: 1_000,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
      reconnectOnError: (error) => error.message.startsWith("READONLY "),
    });
    this.redis.on("error", () => this.warnUnavailable());
    this.redis.on("ready", () => this.markAvailable());
  }

  async get(identity: VerifiedIdentity): Promise<UserAccessCacheResult> {
    const key = userAccessCacheKey(this.options.namespace, identity);
    const result = await this.run((redis) => redis.get(key));
    if (result.status === "unavailable") return result;
    if (result.value === null) return { status: "miss" };

    let payload: unknown;
    try {
      payload = JSON.parse(result.value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const parsed = SnapshotSchema.safeParse(payload);
    if (!parsed.success || !matchesIdentity(parsed.data, identity)) {
      this.warnInvalidEntry();
      await this.delete(identity);
      return { status: "miss" };
    }

    const { version: _version, ...user } = parsed.data;
    return { status: "hit", user: { ...user, isAuthenticated: true, isService: false } };
  }

  async set(identity: VerifiedIdentity, user: AuthenticatedUser): Promise<UserAccessCacheWriteResult> {
    if (!isActiveUserAccess(identity, user)) {
      throw new TypeError("Cannot cache an invalid user access principal");
    }
    const payload = JSON.stringify(snapshotFor(user));
    const key = userAccessCacheKey(this.options.namespace, identity);
    const result = await this.run((redis) =>
      redis.set(key, payload, "EX", this.options.ttlSeconds));
    return { status: result.status };
  }

  async delete(identity: VerifiedIdentity): Promise<UserAccessCacheWriteResult> {
    const key = userAccessCacheKey(this.options.namespace, identity);
    const result = await this.run((redis) => redis.del(key));
    return { status: result.status };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // No network-dependent QUIT: also cancels pending background reconnection.
    this.redis?.disconnect();
  }

  private async run<T>(operation: (redis: Redis) => Promise<T>): Promise<RedisResult<T>> {
    if (this.closed) return { status: "unavailable" };
    if (!this.redis || this.redis.status !== "ready") {
      this.warnUnavailable();
      return { status: "unavailable" };
    }
    try {
      const value = await operation(this.redis);
      this.markAvailable();
      return { status: "ok", value };
    } catch (error) {
      if (!isExpectedRedisError(error)) throw error;
      this.warnUnavailable();
      return { status: "unavailable" };
    }
  }

  private warnUnavailable(): void {
    this.unavailable = true;
    const now = Date.now();
    if (now - this.lastUnavailableLog < LOG_INTERVAL_MS) return;
    this.lastUnavailableLog = now;
    console.warn("[user-access-cache] Redis unavailable; falling back to MongoDB");
  }

  private warnInvalidEntry(): void {
    const now = Date.now();
    if (now - this.lastInvalidEntryLog < LOG_INTERVAL_MS) return;
    this.lastInvalidEntryLog = now;
    console.warn("[user-access-cache] Invalid active-user snapshot; evicting and falling back to MongoDB");
  }

  private markAvailable(): void {
    if (!this.unavailable) return;
    this.unavailable = false;
    const now = Date.now();
    if (now - this.lastRecoveryLog < LOG_INTERVAL_MS) return;
    this.lastRecoveryLog = now;
    console.info("[user-access-cache] Redis available again");
  }
}
