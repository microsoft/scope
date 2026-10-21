// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { MongoNetworkError, MongoServerError, type Collection } from "mongodb";
import type { UserDocument, UserProfile, VerifiedIdentity } from "shared";
import { UserStore } from "./user-store.js";

const IDENTITY: VerifiedIdentity = {
  idp: "entra",
  idpTenant: "tenant-1",
  idpSubject: "subject-1",
  email: "user@example.com",
  displayName: "Test User",
  emailVerified: true,
};

const PROFILE: UserProfile = {
  email: "user@example.com",
  displayName: "Test User",
  emailVerified: true,
};

function baseDoc(overrides: Partial<UserDocument> = {}): UserDocument {
  return {
    _id: "user-uuid-1",
    idp: "entra",
    idpTenant: "tenant-1",
    idpSubject: "subject-1",
    email: "user@example.com",
    displayName: "Test User",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as UserDocument;
}

/** Fake collection whose findOneAndUpdate returns queued documents in order. */
function fakeCollection(queue: (UserDocument | null)[]) {
  const findOneAndUpdate = vi.fn(async (
    _filter: unknown, _update: unknown, _options: unknown,
  ) => queue.shift() ?? null);
  const findOne = vi.fn<(filter: unknown) => Promise<UserDocument | null>>(async () => queue.shift() ?? null);
  const collection = { findOneAndUpdate, findOne } as unknown as
    Collection<UserDocument>;
  return { collection, findOneAndUpdate, findOne };
}

describe("UserStore.upsertOnLogin", () => {
  it("upserts by the identity triple with app-owned insert defaults", async () => {
    const { collection, findOneAndUpdate } = fakeCollection([baseDoc()]);
    const store = new UserStore(collection);

    const user = await store.upsertOnLogin(IDENTITY, PROFILE);

    expect(user.role).toBe("user");
    expect(findOneAndUpdate).toHaveBeenCalledOnce();
    const [filter, update, options] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      idp: "entra",
      idpTenant: "tenant-1",
      idpSubject: "subject-1",
    });
    expect(options).toMatchObject({ upsert: true, returnDocument: "after" });

    const u = update as {
      $set: Record<string, unknown>;
      $setOnInsert: Record<string, unknown>;
    };
    expect(u.$set.email).toBe("user@example.com");
    expect(u.$set.displayName).toBe("Test User");
    expect(u.$set.lastLoginAt).toBeInstanceOf(Date);
    expect(u.$setOnInsert.role).toBe("user");
    expect(typeof u.$setOnInsert._id).toBe("string");
    expect(u.$setOnInsert.createdAt).toBeInstanceOf(Date);
    // The insert must not carry idp fields in $set (they belong to $setOnInsert
    // + the filter) to avoid a Mongo path conflict.
    expect(u.$set.idp).toBeUndefined();
  });

  it("does not clobber known values when a profile claim is missing", async () => {
    const { collection, findOneAndUpdate } = fakeCollection([baseDoc()]);
    const store = new UserStore(collection);

    await store.upsertOnLogin(IDENTITY, { displayName: "Only Name" });

    const update = findOneAndUpdate.mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set.displayName).toBe("Only Name");
    expect("email" in update.$set).toBe(false);
    expect("emailVerified" in update.$set).toBe(false);
    expect("alias" in update.$set).toBe(false);
  });

  it("does not persist an email that is not verified", async () => {
    const { collection, findOneAndUpdate } = fakeCollection([baseDoc()]);
    const store = new UserStore(collection);

    await store.upsertOnLogin(IDENTITY, {
      email: "unverified@example.com",
      alias: "login-alias@example.com",
      emailVerified: false,
    });

    const update = findOneAndUpdate.mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect("email" in update.$set).toBe(false);
    expect(update.$set.emailVerified).toBe(false);
    expect(update.$set.alias).toBe("login-alias@example.com");
    expect(update.$set.role).toBeUndefined();
  });

  it.each(["user", "admin"])("preserves the existing %s role without any privilege write on login", async role => {
    const { collection, findOneAndUpdate, findOne } = fakeCollection([baseDoc({ role })]);
    expect(await new UserStore(collection).upsertOnLogin(IDENTITY, PROFILE)).toMatchObject({ role });
    expect(findOneAndUpdate).toHaveBeenCalledOnce();
    expect(findOneAndUpdate.mock.calls[0][1]).not.toHaveProperty("$set.role");
    expect(findOne).not.toHaveBeenCalled();
  });

  it("does not promote a demoted user or remove an account disable marker", async () => {
    const { collection, findOneAndUpdate } = fakeCollection([baseDoc({ role: "user", disabledAt: new Date() })]);
    expect(await new UserStore(collection).upsertOnLogin(IDENTITY, PROFILE)).toMatchObject({ role: "user", disabledAt: expect.any(Date) });
    expect(findOneAndUpdate.mock.calls[0][1]).not.toHaveProperty("$set.role");
    expect(findOneAndUpdate.mock.calls[0][1]).not.toHaveProperty("$unset");
  });

  it("throws when the upsert returns nothing", async () => {
    const { collection } = fakeCollection([null]);
    const store = new UserStore(collection);

    await expect(store.upsertOnLogin(IDENTITY, PROFILE)).rejects.toThrow();
  });

  it("retries only the update when a concurrent login wins the unique identity insert", async () => {
    const { collection, findOneAndUpdate } = fakeCollection([baseDoc({ role: "admin" })]);
    findOneAndUpdate.mockRejectedValueOnce(new MongoServerError({
      code: 11000,
      keyPattern: { idp: 1, idpTenant: 1, idpSubject: 1 },
      keyValue: { idp: IDENTITY.idp, idpTenant: IDENTITY.idpTenant, idpSubject: IDENTITY.idpSubject },
    }));
    const store = new UserStore(collection);

    expect(await store.upsertOnLogin(IDENTITY, PROFILE)).toMatchObject({
      _id: "user-uuid-1", role: "admin",
    });
    const [filter, update, options] = findOneAndUpdate.mock.calls[1];
    expect(filter).toEqual(findOneAndUpdate.mock.calls[0][0]);
    expect(options).toEqual({ upsert: false, returnDocument: "after" });
    expect(update).toEqual({
      $set: expect.objectContaining({
        email: PROFILE.email,
        displayName: PROFILE.displayName,
        lastLoginAt: expect.any(Date),
      }),
    });
  });

  it("recognizes the exact named identity index when Cosmos omits index metadata", async () => {
    const { collection, findOneAndUpdate } = fakeCollection([baseDoc()]);
    findOneAndUpdate.mockRejectedValueOnce(new MongoServerError({
      code: 11000, message: "E11000 duplicate key error index: uniq_identity dup key: {}",
    }));
    await expect(new UserStore(collection).upsertOnLogin(IDENTITY, PROFILE)).resolves.toEqual(baseDoc({
      createdAt: expect.any(Date), updatedAt: expect.any(Date),
    }));
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it.each([
    new MongoNetworkError("connection lost"),
    new MongoServerError({ code: 11000, keyPattern: { _id: 1 } }),
    new MongoServerError({ code: 11000, message: "duplicate key" }),
    new MongoServerError({ code: 11000, message: "index: uniq_identity_extra dup key: {}" }),
    new MongoServerError({
      code: 11000, keyPattern: { idp: 1, idpTenant: 1, idpSubject: 1 },
      keyValue: { idp: "entra", idpTenant: "another-tenant", idpSubject: "subject-1" },
    }),
    new MongoServerError({ code: 121, keyPattern: { idp: 1, idpTenant: 1, idpSubject: 1 } }),
    Object.assign(new Error("duplicate key"), {
      code: 11000, keyPattern: { idp: 1, idpTenant: 1, idpSubject: 1 },
    }),
  ])("does not retry unrelated failures ($name)", async (error) => {
    const { collection, findOneAndUpdate } = fakeCollection([]);
    findOneAndUpdate.mockRejectedValueOnce(error);
    await expect(new UserStore(collection).upsertOnLogin(IDENTITY, PROFILE)).rejects.toBe(error);
    expect(findOneAndUpdate).toHaveBeenCalledOnce();
  });

  it("does not loop if the identity collision retry fails or no longer finds the winner", async () => {
    const { collection, findOneAndUpdate } = fakeCollection([null]);
    const error = new MongoServerError({
      code: 11000, keyPattern: { idp: 1, idpTenant: 1, idpSubject: 1 },
    });
    findOneAndUpdate.mockRejectedValueOnce(error);
    await expect(new UserStore(collection).upsertOnLogin(IDENTITY, PROFILE)).rejects.toBe(error);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("UserStore.findByIdentity", () => {
  it("looks up the exact identity triple without writing login or profile data", async () => {
    const { collection, findOne, findOneAndUpdate } = fakeCollection([]);
    const doc = baseDoc();
    findOne.mockResolvedValueOnce(doc);
    const store = new UserStore(collection);

    expect(await store.findByIdentity(IDENTITY)).toBe(doc);
    expect(findOne).toHaveBeenCalledExactlyOnceWith({
      idp: "entra", idpTenant: "tenant-1", idpSubject: "subject-1",
    });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("returns null for a missing identity without enrolling", async () => {
    const { collection, findOneAndUpdate } = fakeCollection([]);
    expect(await new UserStore(collection).findByIdentity(IDENTITY)).toBeNull();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("preserves database errors for the resolver to classify", async () => {
    const { collection, findOne } = fakeCollection([]);
    const error = new MongoNetworkError("unreachable");
    findOne.mockRejectedValueOnce(error);
    await expect(new UserStore(collection).findByIdentity(IDENTITY)).rejects.toBe(error);
  });
});

describe("UserStore.findById", () => {
  it("looks up by _id", async () => {
    const { collection, findOne } = fakeCollection([]);
    (findOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce(baseDoc());
    const store = new UserStore(collection);

    const user = await store.findById("user-uuid-1");

    expect(user?._id).toBe("user-uuid-1");
    expect(findOne).toHaveBeenCalledWith({ _id: "user-uuid-1" });
  });
});
