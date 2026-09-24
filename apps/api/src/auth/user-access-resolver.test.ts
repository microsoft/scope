// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  MongoNetworkError,
  MongoNotConnectedError,
  MongoOperationTimeoutError,
  MongoServerError,
  MongoServerSelectionError,
} from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { ProfileEnricher, UserDocument, VerifiedIdentity } from "shared";
import type { AuthenticatedUser } from "./types.js";
import type { UserAccessCache } from "./user-access-cache.js";
import {
  UserAccessError,
  UserAccessResolver,
  type UserAccessResolverOptions,
  type UserAccessService,
} from "./user-access-resolver.js";

const IDENTITY: VerifiedIdentity = {
  idp: "entra", idpTenant: "tenant-1", idpSubject: "subject-1",
  email: "claim@example.com", displayName: "Token Name", emailVerified: true,
};
const PRINCIPAL: AuthenticatedUser = {
  id: "scope-uuid-1", role: "admin", isAuthenticated: true, isService: false,
  idp: "entra", idpTenant: "tenant-1", idpSubject: "subject-1",
  email: "verified@example.com", displayName: "Stored Name",
};

function document(overrides: Partial<UserDocument> = {}): UserDocument {
  return {
    _id: PRINCIPAL.id, role: "admin",
    idp: IDENTITY.idp, idpTenant: IDENTITY.idpTenant, idpSubject: IDENTITY.idpSubject,
    email: PRINCIPAL.email, displayName: PRINCIPAL.displayName,
    createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
    lastLoginAt: new Date("2026-01-01"), ...overrides,
  };
}

function setup() {
  const userStore = {
    findByIdentity: vi.fn<UserAccessResolverOptions["userStore"]["findByIdentity"]>()
      .mockResolvedValue(document()),
    upsertOnLogin: vi.fn<UserAccessResolverOptions["userStore"]["upsertOnLogin"]>()
      .mockResolvedValue(document()),
  };
  const cache = {
    get: vi.fn<UserAccessCache["get"]>().mockResolvedValue({ status: "miss" }),
    set: vi.fn<UserAccessCache["set"]>().mockResolvedValue({ status: "ok" }),
    delete: vi.fn<UserAccessCache["delete"]>().mockResolvedValue({ status: "ok" }),
    close: vi.fn<UserAccessCache["close"]>().mockResolvedValue(undefined),
  };
  const enricher = {
    id: "test",
    enrich: vi.fn<ProfileEnricher["enrich"]>().mockResolvedValue({
      email: "enriched@example.com", displayName: "Enriched Name", emailVerified: true,
    }),
  };
  const resolver: UserAccessService = new UserAccessResolver({ userStore, cache, enricher });
  return { resolver, userStore, cache, enricher };
}

describe("UserAccessResolver.resolveExisting", () => {
  it("uses an active cache hit without a Mongo read, profile enrichment, upsert or TTL refresh", async () => {
    const { resolver, userStore, cache, enricher } = setup();
    cache.get.mockResolvedValue({ status: "hit", user: PRINCIPAL });
    expect(await resolver.resolveExisting(IDENTITY)).toEqual(PRINCIPAL);
    expect(cache.get).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(userStore.findByIdentity).not.toHaveBeenCalled();
    expect(userStore.upsertOnLogin).not.toHaveBeenCalled();
    expect(enricher.enrich).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each(["miss", "unavailable"] as const)("reads Mongo and warms the cache on %s without login writes", async (status) => {
    const { resolver, userStore, cache, enricher } = setup();
    cache.get.mockResolvedValue({ status });
    expect(await resolver.resolveExisting(IDENTITY)).toEqual(PRINCIPAL);
    expect(userStore.findByIdentity).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(cache.set).toHaveBeenCalledExactlyOnceWith(IDENTITY, PRINCIPAL);
    expect(userStore.upsertOnLogin).not.toHaveBeenCalled();
    expect(enricher.enrich).not.toHaveBeenCalled();
  });

  it("does not invent profile fields from current claims or persist mutable DB data", async () => {
    const { resolver, userStore, cache } = setup();
    const stored = document({ email: undefined, displayName: undefined, permissionsAdd: ["unused"] });
    userStore.findByIdentity.mockResolvedValue(stored);
    const user = await resolver.resolveExisting(IDENTITY);
    expect(user).toEqual({
      id: PRINCIPAL.id, role: "admin", isAuthenticated: true, isService: false,
      idp: "entra", idpTenant: "tenant-1", idpSubject: "subject-1",
    });
    expect(user).not.toBe(stored);
    expect(cache.set.mock.calls[0][1]).not.toHaveProperty("lastLoginAt");
    expect(cache.set.mock.calls[0][1]).not.toHaveProperty("permissionsAdd");
  });

  it("keeps database access decisions authoritative when cache warming is unavailable", async () => {
    const { resolver, cache } = setup();
    cache.set.mockResolvedValue({ status: "unavailable" });
    expect(await resolver.resolveExisting(IDENTITY)).toEqual(PRINCIPAL);
  });
});

describe("UserAccessResolver.enrollOnLogin", () => {
  it("bypasses active cache hits, enriches/upserts and caches the freshly stored role/profile", async () => {
    const { resolver, userStore, cache, enricher } = setup();
    cache.get.mockResolvedValue({ status: "hit", user: { ...PRINCIPAL, role: "user" } });
    expect(await resolver.enrollOnLogin(IDENTITY, "bearer-secret")).toEqual(PRINCIPAL);
    expect(cache.get).not.toHaveBeenCalled();
    expect(userStore.findByIdentity).not.toHaveBeenCalled();
    expect(enricher.enrich).toHaveBeenCalledExactlyOnceWith(IDENTITY, "bearer-secret");
    expect(userStore.upsertOnLogin).toHaveBeenCalledExactlyOnceWith(IDENTITY, {
      email: "enriched@example.com", displayName: "Enriched Name", emailVerified: true,
    });
    expect(cache.set).toHaveBeenCalledExactlyOnceWith(IDENTITY, PRINCIPAL);
    expect(JSON.stringify(cache.set.mock.calls)).not.toContain("bearer-secret");
  });

  it("uses identity profile claims when no enricher is configured", async () => {
    const { userStore, cache } = setup();
    const resolver = new UserAccessResolver({ userStore, cache, enricher: null });
    expect(await resolver.enrollOnLogin(IDENTITY, "raw-token")).toEqual(PRINCIPAL);
    expect(userStore.upsertOnLogin).toHaveBeenCalledExactlyOnceWith(IDENTITY, {
      email: IDENTITY.email, displayName: IDENTITY.displayName, emailVerified: true,
    });
  });

  it("preserves profile/upsert ordering before disabled validation but evicts cached active access", async () => {
    const { resolver, userStore, cache, enricher } = setup();
    userStore.upsertOnLogin.mockResolvedValue(document({ disabledAt: new Date() }));
    await expect(resolver.enrollOnLogin(IDENTITY, "raw-token")).rejects.toMatchObject({
      code: "user_disabled", status: 403,
    });
    expect(enricher.enrich).toHaveBeenCalledOnce();
    expect(userStore.upsertOnLogin).toHaveBeenCalledOnce();
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("does not reinterpret enrichment errors as MongoDB availability failures", async () => {
    const { resolver, userStore, cache, enricher } = setup();
    const error = new MongoNetworkError("not raised by the user store");
    enricher.enrich.mockRejectedValue(error);
    await expect(resolver.enrollOnLogin(IDENTITY, "raw-token")).rejects.toBe(error);
    expect(userStore.upsertOnLogin).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe.each(["resolveExisting", "enrollOnLogin"] as const)("%s access validation", (method) => {
  it.each([
    ["missing", null, "user_not_enrolled", 403],
    ["disabled", document({ disabledAt: new Date() }), "user_disabled", 403],
    ["system", document({ _id: "system" }), "invalid_principal", 401],
    ["anonymous", document({ _id: "anonymous" }), "invalid_principal", 401],
    ["empty ID", document({ _id: "" }), "invalid_principal", 401],
    ["provider mismatch", document({ idp: "other" }), "invalid_principal", 401],
    ["tenant mismatch", document({ idpTenant: "other" }), "invalid_principal", 401],
    ["subject mismatch", document({ idpSubject: "other" }), "invalid_principal", 401],
  ] as const)("denies %s and best-effort evicts without negative caching", async (_reason, stored, code, status) => {
    const { resolver, userStore, cache } = setup();
    userStore.findByIdentity.mockResolvedValue(stored);
    if (stored) userStore.upsertOnLogin.mockResolvedValue(stored);
    else userStore.upsertOnLogin.mockResolvedValue(null as unknown as UserDocument);
    cache.delete.mockResolvedValue({ status: "unavailable" });

    await expect(resolver[method](IDENTITY, "raw-token")).rejects.toMatchObject({
      name: "UserAccessError", code, status,
    });
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each([
    new MongoNetworkError("offline"),
    new MongoServerSelectionError(
      "no primary",
      {} as ConstructorParameters<typeof MongoServerSelectionError>[1],
    ),
    new MongoNotConnectedError("not connected"),
    new MongoOperationTimeoutError("deadline"),
    new MongoServerError({ code: 91, message: "ShutdownInProgress" }),
  ])("maps expected Mongo availability errors to 503 ($name)", async (error) => {
    const { resolver, userStore, cache } = setup();
    cache.get.mockResolvedValue({ status: "unavailable" });
    userStore.findByIdentity.mockRejectedValue(error);
    userStore.upsertOnLogin.mockRejectedValue(error);
    await expect(resolver[method](IDENTITY, "raw-token")).rejects.toMatchObject({
      code: "service_unavailable", status: 503,
    });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each([
    new TypeError("programming bug"),
    new Error("unknown database error"),
    new MongoServerError({ code: 121, message: "validation failure" }),
    new MongoServerError({ code: 11000, message: "unrelated unique-index failure" }),
    Object.assign(new Error("not a real Mongo error"), { name: "MongoNetworkError" }),
  ])("propagates unexpected errors unchanged ($message)", async (error) => {
    const { resolver, userStore, cache } = setup();
    userStore.findByIdentity.mockRejectedValue(error);
    userStore.upsertOnLogin.mockRejectedValue(error);
    await expect(resolver[method](IDENTITY, "raw-token")).rejects.toBe(error);
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe("UserAccessError", () => {
  it("allows a safe public message override and exposes its stable status/code", () => {
    const error = new UserAccessError("invalid_principal", "No human principal");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "UserAccessError", message: "No human principal", code: "invalid_principal", status: 401,
    });
  });
});
