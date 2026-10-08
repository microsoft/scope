// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RedisOptions } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedisConfig, VerifiedIdentity } from "shared";
import type { AuthenticatedUser } from "./types.js";
import { RedisUserAccessCache, userAccessCacheKey } from "./user-access-cache.js";

const { redis, RedisMock } = vi.hoisted(() => {
  const redis = {
    status: "ready",
    get: vi.fn<(key: string) => Promise<string | null>>(),
    set: vi.fn<(key: string, value: string, expiry: "EX", ttl: number) => Promise<"OK">>(),
    del: vi.fn<(key: string) => Promise<number>>(),
    disconnect: vi.fn<() => void>(),
    on: vi.fn<(event: string, handler: () => void) => void>(),
  };
  return {
    redis,
    RedisMock: vi.fn(function (_options: RedisOptions) { return redis; }),
  };
});

vi.mock("ioredis", () => ({ Redis: RedisMock }));

const IDENTITY: VerifiedIdentity = {
  idp: "entra", idpTenant: "tenant-1", idpSubject: "subject-1",
  email: "claim@example.com",
};
const USER: AuthenticatedUser = {
  id: "scope-uuid-1", role: "admin", isAuthenticated: true, isService: false,
  idp: IDENTITY.idp, idpTenant: IDENTITY.idpTenant, idpSubject: IDENTITY.idpSubject,
  email: "verified@example.com", displayName: "Stored Name",
};
const SNAPSHOT = {
  version: 1, id: USER.id, role: USER.role,
  idp: USER.idp, idpTenant: USER.idpTenant, idpSubject: USER.idpSubject,
  email: USER.email, displayName: USER.displayName,
};
const CONFIG: RedisConfig = { redisHost: "redis", redisPort: 6379, redisPassword: "" };
const OPTIONS = { ttlSeconds: 300, namespace: "scope-db" };
const KEY = "auth-user:v1:scope-db:entra:tenant-1:subject-1";
const networkError = () => Object.assign(new Error("sensitive connection details"), { code: "ECONNRESET" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("REDIS_TLS", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  redis.status = "ready";
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue("OK");
  redis.del.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("RedisUserAccessCache", () => {
  it("encodes every namespace/provider/tenant/subject component independently", () => {
    const identity = { ...IDENTITY, idp: "idp:one", idpTenant: "tid/\u00e9", idpSubject: "oid:%" };
    expect(userAccessCacheKey("db:one/two", identity))
      .toBe("auth-user:v1:db%3Aone%2Ftwo:idp%3Aone:tid%2F%C3%A9:oid%3A%25");
    expect(userAccessCacheKey("a:b", IDENTITY))
      .not.toBe(userAccessCacheKey("a", { ...IDENTITY, idp: "b:entra" }));
    expect(userAccessCacheKey("one", IDENTITY)).not.toBe(userAccessCacheKey("two", IDENTITY));
    expect(userAccessCacheKey("one", { ...IDENTITY, email: "different@example.com" }))
      .toBe(userAccessCacheKey("one", IDENTITY));
  });

  it("bounds connection/command waits and does not queue or replay writes on reconnect", () => {
    new RedisUserAccessCache(CONFIG, OPTIONS);
    const options = RedisMock.mock.calls[0][0];
    expect(options).toMatchObject({
      host: "redis", port: 6379, connectTimeout: 1_000, commandTimeout: 500,
      socketTimeout: 1_000, enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false, maxRetriesPerRequest: 0,
    });
    expect(options.retryStrategy?.(1)).toBe(250);
    expect(options.retryStrategy?.(100)).toBe(5_000);
    expect(options.reconnectOnError?.(new Error("READONLY replica"))).toBe(true);
    expect(options.reconnectOnError?.(new Error("other error"))).toBe(false);
  });

  it("uses certificate validation with explicit TLS and honors an explicit TLS disable", () => {
    vi.stubEnv("REDIS_TLS", "true");
    new RedisUserAccessCache(CONFIG, OPTIONS);
    expect(RedisMock.mock.calls[0][0].tls).toEqual({});
    vi.stubEnv("REDIS_TLS", "false");
    new RedisUserAccessCache({ ...CONFIG, redisHost: "remote", redisPassword: "secret" }, OPTIONS);
    expect(RedisMock.mock.calls[1][0].tls).toBeUndefined();
    vi.stubEnv("REDIS_TLS", undefined);
    new RedisUserAccessCache({ ...CONFIG, redisHost: "remote", redisPassword: "secret" }, OPTIONS);
    expect(RedisMock.mock.calls[2][0].tls).toEqual({});
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid TTL %s", (ttlSeconds) => {
    expect(() => new RedisUserAccessCache(CONFIG, { ...OPTIONS, ttlSeconds }))
      .toThrow(/positive safe integer/);
    expect(RedisMock).not.toHaveBeenCalled();
  });

  it("requires a non-empty deployment/database namespace", () => {
    expect(() => new RedisUserAccessCache(CONFIG, { ...OPTIONS, namespace: " " }))
      .toThrow(/namespace/);
    expect(RedisMock).not.toHaveBeenCalled();
  });

  it("reports unavailable without creating Redis when the host is absent", async () => {
    const cache = new RedisUserAccessCache({ ...CONFIG, redisHost: "" }, OPTIONS);
    expect(await cache.get(IDENTITY)).toEqual({ status: "unavailable" });
    expect(await cache.set(IDENTITY, USER)).toEqual({ status: "unavailable" });
    expect(await cache.delete(IDENTITY)).toEqual({ status: "unavailable" });
    await cache.close();
    expect(RedisMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("returns an explicit miss when Redis has no entry", async () => {
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    expect(await cache.get(IDENTITY)).toEqual({ status: "miss" });
    expect(redis.get).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("returns the active stored principal without extending TTL", async () => {
    redis.get.mockResolvedValue(JSON.stringify(SNAPSHOT));
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    expect(await cache.get(IDENTITY)).toEqual({ status: "hit", user: USER });
    expect(await cache.get(IDENTITY)).toEqual({ status: "hit", user: USER });
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("writes only a versioned minimal snapshot in one atomic SET EX, never tokens", async () => {
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    const userWithExtras = { ...USER, rawToken: "secret bearer", permissionsAdd: ["all"] };
    expect(await cache.set(IDENTITY, userWithExtras)).toEqual({ status: "ok" });
    expect(redis.set).toHaveBeenCalledExactlyOnceWith(KEY, JSON.stringify(SNAPSHOT), "EX", 300);
    expect(redis.set.mock.calls[0][1]).not.toContain("secret");
  });

  it("expires at the original fixed TTL despite repeated cache hits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const entries = new Map<string, { payload: string; expiresAt: number }>();
    redis.set.mockImplementation(async (key, payload, _ex, ttl) => {
      entries.set(key, { payload, expiresAt: Date.now() + ttl * 1000 });
      return "OK";
    });
    redis.get.mockImplementation(async (key) => {
      const entry = entries.get(key);
      return entry && entry.expiresAt > Date.now() ? entry.payload : null;
    });
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    await cache.set(IDENTITY, USER);
    await vi.advanceTimersByTimeAsync(299_999);
    expect((await cache.get(IDENTITY)).status).toBe("hit");
    await vi.advanceTimersByTimeAsync(1);
    expect((await cache.get(IDENTITY)).status).toBe("miss");
    expect(redis.set).toHaveBeenCalledOnce();
  });

  it.each([
    ["broken JSON", "private malformed contents"],
    ["null", "null"],
    ["array", "[]"],
    ["unsupported version", JSON.stringify({ ...SNAPSHOT, version: 2 })],
    ["missing role", JSON.stringify({ ...SNAPSHOT, role: undefined })],
    ["invalid role", JSON.stringify({ ...SNAPSHOT, role: [] })],
    ["empty ID", JSON.stringify({ ...SNAPSHOT, id: "" })],
    ["system principal", JSON.stringify({ ...SNAPSHOT, id: "system" })],
    ["anonymous principal", JSON.stringify({ ...SNAPSHOT, id: "anonymous" })],
    ["other provider", JSON.stringify({ ...SNAPSHOT, idp: "other" })],
    ["other tenant", JSON.stringify({ ...SNAPSHOT, idpTenant: "other" })],
    ["other subject", JSON.stringify({ ...SNAPSHOT, idpSubject: "other" })],
    ["disabled flag", JSON.stringify({ ...SNAPSHOT, disabledAt: "2026-09-14" })],
    ["bearer field", JSON.stringify({ ...SNAPSHOT, rawToken: "secret bearer" })],
    ["invalid profile", JSON.stringify({ ...SNAPSHOT, displayName: 3 })],
  ])("logs, evicts and misses on %s", async (_label, value) => {
    redis.get.mockResolvedValue(value);
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    expect(await cache.get(IDENTITY)).toEqual({ status: "miss" });
    expect(redis.del).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(redis.set).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Invalid active-user snapshot"));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(value);
  });

  it.each([
    { ...USER, isAuthenticated: false },
    { ...USER, isService: true },
    { ...USER, id: "system" },
    { ...USER, id: "anonymous" },
    { ...USER, idpTenant: "other" },
    { ...USER, role: undefined },
  ])("rejects invalid write principals without a Redis command", async (user) => {
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    await expect(cache.set(IDENTITY, user)).rejects.toThrow(TypeError);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it.each([
    networkError(),
    Object.assign(new Error("redis server failure"), { name: "ReplyError" }),
    Object.assign(new Error("retry limit"), { name: "MaxRetriesPerRequestError" }),
    new Error("Command timed out"),
    new Error("Socket timeout. Expecting data, but didn't receive any in 1000ms."),
    new Error("Connection is closed."),
    new Error("Stream isn't writeable and enableOfflineQueue options is false"),
  ])("reports and logs expected Redis read failures ($message)", async (error) => {
    redis.get.mockRejectedValue(error);
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    expect(await cache.get(IDENTITY)).toEqual({ status: "unavailable" });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Redis unavailable"));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(error.message);
  });

  it("reports write/delete outages without granting or hiding database access decisions", async () => {
    redis.set.mockRejectedValue(networkError());
    redis.del.mockRejectedValue(networkError());
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    expect(await cache.set(IDENTITY, USER)).toEqual({ status: "unavailable" });
    expect(await cache.delete(IDENTITY)).toEqual({ status: "unavailable" });
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("still treats corruption as a miss if best-effort eviction is unavailable", async () => {
    redis.get.mockResolvedValue("malformed");
    redis.del.mockRejectedValue(networkError());
    expect(await new RedisUserAccessCache(CONFIG, OPTIONS).get(IDENTITY)).toEqual({ status: "miss" });
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("does not wait for Redis to connect or reconnect and recovers once ready", async () => {
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    for (const status of ["connecting", "reconnecting", "end"]) {
      redis.status = status;
      expect(await cache.get(IDENTITY)).toEqual({ status: "unavailable" });
      expect(await cache.set(IDENTITY, USER)).toEqual({ status: "unavailable" });
    }
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    redis.status = "ready";
    redis.on.mock.calls.find(([event]) => event === "ready")?.[1]();
    expect(await cache.get(IDENTITY)).toEqual({ status: "miss" });
    expect(console.info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Redis available again"));
  });

  it("rate-limits error events, failed requests, corrupt entries and recovery logs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    redis.get.mockRejectedValue(networkError());
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    const errorEvent = redis.on.mock.calls.find(([event]) => event === "error")?.[1];
    errorEvent?.();
    await cache.get(IDENTITY);
    await cache.get(IDENTITY);
    expect(console.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await cache.get(IDENTITY);
    expect(console.warn).toHaveBeenCalledTimes(2);
    redis.get.mockResolvedValue("invalid");
    await cache.get(IDENTITY);
    await cache.get(IDENTITY);
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(console.info).toHaveBeenCalledOnce();
    errorEvent?.();
    await cache.get(IDENTITY);
    expect(console.info).toHaveBeenCalledOnce();
  });

  it("propagates unexpected implementation failures rather than hiding them as Redis outages", async () => {
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    const error = new TypeError("programmer bug");
    redis.get.mockRejectedValue(error);
    redis.set.mockRejectedValue(error);
    redis.del.mockRejectedValue(error);
    await expect(cache.get(IDENTITY)).rejects.toBe(error);
    await expect(cache.set(IDENTITY, USER)).rejects.toBe(error);
    await expect(cache.delete(IDENTITY)).rejects.toBe(error);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("closes immediately and idempotently without a network-dependent QUIT", async () => {
    const cache = new RedisUserAccessCache(CONFIG, OPTIONS);
    await cache.close();
    await cache.close();
    expect(redis.disconnect).toHaveBeenCalledOnce();
    expect(await cache.get(IDENTITY)).toEqual({ status: "unavailable" });
    expect(redis.get).not.toHaveBeenCalled();
  });
});
