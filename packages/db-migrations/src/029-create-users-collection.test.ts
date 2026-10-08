// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { MongoNetworkError, MongoServerError, type Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sleep } from "./batch-update.js";
import { CreateUsersCollection } from "./migrations/029-create-users-collection.js";

vi.mock("./batch-update.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./batch-update.js")>(),
  sleep: vi.fn(async () => {}),
}));

interface TestIndex {
  key: Record<string, number>;
  name: string;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  collation?: { locale: string };
}

const identityIndex: TestIndex = {
  key: { idp: 1, idpTenant: 1, idpSubject: 1 },
  name: "uniq_identity",
  unique: true,
};
const idIndex: TestIndex = { key: { _id: 1 }, name: "_id_1", unique: true };
const emailIndex: TestIndex = { key: { email: 1 }, name: "email", sparse: true };
const cosmosEmailIndex: TestIndex = { key: { email: 1 }, name: "email" };

function makeDb(options: {
  backend?: "cosmos" | "mongo";
  exists?: boolean;
  indexes?: TestIndex[];
  documents?: { _id: string; role: string }[];
} = {}) {
  const state = {
    exists: options.exists ?? false,
    indexes: [...options.indexes ?? []],
    documents: [...options.documents ?? []],
  };
  const command = vi.fn(async (input: {
    customAction: string;
    collection: string;
    indexes?: TestIndex[];
  }): Promise<unknown> => {
    if (options.backend === "mongo") {
      throw new MongoServerError({ code: 59, errmsg: "no such command: 'customAction'" });
    }
    if (input.customAction === "CreateCollection") {
      if (state.exists) throw new MongoServerError({ code: 48, errmsg: "Collection already exists" });
      state.exists = true;
      state.indexes = [...input.indexes ?? []];
    }
    return { ok: 1 };
  });
  const createIndex = vi.fn(async (
    key: Record<string, number>,
    options: { name: string; unique?: boolean; sparse?: boolean },
  ) => {
    if (!state.exists) {
      state.exists = true;
      state.indexes.push(idIndex);
    }
    if (!state.indexes.some((index) => index.name === options.name)) {
      state.indexes.push({ key, ...options });
    }
    return options.name;
  });
  const readIndexes = vi.fn(async (): Promise<unknown> => state.indexes);
  const drop = vi.fn(async () => {
    state.exists = false;
    state.indexes = [];
    state.documents = [];
  });
  const dropIndex = vi.fn();
  const collection = vi.fn(() => ({
    createIndex,
    listIndexes: vi.fn(() => ({ toArray: readIndexes })),
    drop,
    dropIndex,
  }));
  const listCollections = vi.fn(() => ({
    hasNext: vi.fn(async () => state.exists),
  }));
  const db = { command, collection, listCollections, dropCollection: drop } as unknown as Db;
  return { db, command, createIndex, readIndexes, drop, collection, listCollections, state };
}

describe("migration 029: CreateUsersCollection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("creates Cosmos identity indexes atomically and adds a non-sparse email index", async () => {
    const fixture = makeDb();

    await new CreateUsersCollection().up(fixture.db);

    expect(fixture.listCollections).toHaveBeenCalledWith({ name: "users" }, { nameOnly: true });
    expect(fixture.command).toHaveBeenCalledExactlyOnceWith({
      customAction: "CreateCollection",
      collection: "users",
      indexes: [idIndex, identityIndex],
    });
    expect(fixture.createIndex).toHaveBeenCalledExactlyOnceWith({ email: 1 }, { name: "email" });
    expect(fixture.state.indexes).toEqual([idIndex, identityIndex, cosmosEmailIndex]);
    expect(fixture.readIndexes).toHaveBeenCalled();
  });

  it("falls back to native indexes only for an unsupported customAction command", async () => {
    const fixture = makeDb({ backend: "mongo" });

    await new CreateUsersCollection().up(fixture.db);

    expect(fixture.command).toHaveBeenCalledOnce();
    expect(fixture.createIndex).toHaveBeenNthCalledWith(1, identityIndex.key, {
      name: "uniq_identity", unique: true,
    });
    expect(fixture.createIndex).toHaveBeenNthCalledWith(2, emailIndex.key, {
      name: "email", sparse: true,
    });
    expect(fixture.state.indexes).toEqual([idIndex, identityIndex, emailIndex]);
  });

  it.each(["cosmos", "mongo"] as const)("safely reruns on populated %s collections", async (backend) => {
    const documents = [{ _id: "scope-user-id", role: "admin" }];
    const fixture = makeDb({ backend, exists: true, indexes: [idIndex, identityIndex], documents });
    const migration = new CreateUsersCollection();

    await migration.up(fixture.db);
    await migration.up(fixture.db);

    expect(fixture.command).toHaveBeenCalledWith({
      customAction: "GetCollection", collection: "users",
    });
    expect(fixture.command.mock.calls.every(([input]) => input.customAction === "GetCollection")).toBe(true);
    expect(fixture.state.documents).toEqual(documents);
    expect(fixture.drop).not.toHaveBeenCalled();
    if (backend === "cosmos") {
      expect(fixture.createIndex).toHaveBeenCalledExactlyOnceWith({ email: 1 }, { name: "email" });
      expect(fixture.state.indexes).toContainEqual(cosmosEmailIndex);
    } else {
      expect(fixture.state.indexes).toContainEqual(emailIndex);
    }
  });

  it.each([
    cosmosEmailIndex,
    { ...cosmosEmailIndex, unique: false, sparse: false },
  ])("reuses a compatible existing Cosmos email index: %j", async (index) => {
    const fixture = makeDb({ exists: true, indexes: [idIndex, identityIndex, index] });

    await new CreateUsersCollection().up(fixture.db);

    expect(fixture.state.indexes).toContainEqual(index);
    expect(fixture.createIndex).not.toHaveBeenCalled();
    expect(fixture.collection().dropIndex).not.toHaveBeenCalled();
  });

  it.each([
    { documents: [] },
    { documents: [{ _id: "existing-user", role: "admin" }] },
  ])(
    "refuses an existing Cosmos collection without the identity index (documents: $documents)",
    async ({ documents }) => {
      const fixture = makeDb({ exists: true, indexes: [idIndex], documents });

      await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/continuous backup/i);

      expect(fixture.state.documents).toEqual(documents);
      expect(fixture.createIndex).not.toHaveBeenCalled();
      expect(fixture.drop).not.toHaveBeenCalled();
      expect(fixture.command).toHaveBeenCalledExactlyOnceWith({
        customAction: "GetCollection", collection: "users",
      });
    },
  );

  it.each([
    { ...identityIndex, key: { idpSubject: 1 } },
    { ...identityIndex, name: "different_name" },
    { ...identityIndex, unique: false },
    { ...identityIndex, sparse: true },
    { ...identityIndex, partialFilterExpression: { idp: "entra" } },
    { ...identityIndex, collation: { locale: "en" } },
  ])("rejects incompatible Cosmos identity index metadata: %j", async (index) => {
    const fixture = makeDb({ exists: true, indexes: [idIndex, index] });

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/uniq_identity/);

    expect(fixture.createIndex).not.toHaveBeenCalled();
    expect(fixture.drop).not.toHaveBeenCalled();
  });

  it("does not trust successful Cosmos creation without the required index", async () => {
    const fixture = makeDb();
    fixture.command.mockImplementationOnce(async () => {
      fixture.state.exists = true;
      fixture.state.indexes = [idIndex];
      return { ok: 1 };
    });

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/uniq_identity/);
    expect(fixture.createIndex).not.toHaveBeenCalled();
  });

  it("does not trust successful native index creation without the required index", async () => {
    const fixture = makeDb({ backend: "mongo", exists: true, indexes: [idIndex] });
    fixture.createIndex.mockResolvedValueOnce("uniq_identity");

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/uniq_identity/);
    expect(fixture.createIndex).toHaveBeenCalledOnce();
  });

  it.each([undefined, { ok: 0 }, { ok: "1" }])("rejects malformed Cosmos responses: %j", async (response) => {
    const fixture = makeDb();
    fixture.command.mockResolvedValueOnce(response);

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/response/i);
    expect(fixture.createIndex).not.toHaveBeenCalled();
  });

  it("rejects malformed index metadata", async () => {
    const fixture = makeDb();
    fixture.readIndexes.mockResolvedValueOnce({ indexes: [identityIndex] });

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/index metadata/i);
  });

  it("rechecks a recognized concurrent collection-creation race", async () => {
    const fixture = makeDb();
    fixture.command.mockImplementationOnce(async () => {
      fixture.state.exists = true;
      fixture.state.indexes = [idIndex, identityIndex];
      throw new MongoServerError({ code: 48, errmsg: "Collection already exists" });
    });

    await new CreateUsersCollection().up(fixture.db);

    expect(fixture.command).toHaveBeenNthCalledWith(2, {
      customAction: "GetCollection", collection: "users",
    });
    expect(fixture.readIndexes).toHaveBeenCalled();
    expect(fixture.createIndex).toHaveBeenCalledExactlyOnceWith({ email: 1 }, { name: "email" });
  });

  it("does not accept a concurrent creator's incompatible collection", async () => {
    const fixture = makeDb();
    fixture.command.mockImplementationOnce(async () => {
      fixture.state.exists = true;
      fixture.state.indexes = [idIndex];
      throw new MongoServerError({ code: 48, errmsg: "Collection already exists" });
    });

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/uniq_identity/);
    expect(fixture.createIndex).not.toHaveBeenCalled();
  });

  it("recovers on rerun when creation completed before a transport failure", async () => {
    const fixture = makeDb();
    const error = new MongoNetworkError("response lost");
    fixture.command.mockImplementationOnce(async () => {
      fixture.state.exists = true;
      fixture.state.indexes = [idIndex, identityIndex];
      throw error;
    });

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toBe(error);
    expect(sleep).not.toHaveBeenCalled();
    await new CreateUsersCollection().up(fixture.db);

    expect(fixture.command).toHaveBeenNthCalledWith(2, {
      customAction: "GetCollection", collection: "users",
    });
    expect(fixture.createIndex).toHaveBeenCalledExactlyOnceWith({ email: 1 }, { name: "email" });
  });

  it("respects throttling delay and rechecks state before retrying creation", async () => {
    const fixture = makeDb();
    fixture.command.mockRejectedValueOnce(new MongoServerError({
      code: 16500, errmsg: "Too many requests; RetryAfterMs=3000",
    }));

    await new CreateUsersCollection().up(fixture.db);

    expect(sleep).toHaveBeenCalledExactlyOnceWith(3000);
    expect(fixture.listCollections).toHaveBeenCalledTimes(2);
  });

  it.each([48, 16500])("bounds retries for error %i", async (code) => {
    const fixture = makeDb();
    const error = new MongoServerError({ code, errmsg: "Retryable failure" });
    fixture.command.mockRejectedValue(error);

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toBe(error);
    expect(fixture.command).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each([
    new MongoServerError({ code: 13, errmsg: "not authorized" }),
    new MongoServerError({ code: 67, errmsg: "Cannot create unique index" }),
    new MongoServerError({ code: 115, errmsg: "Command not supported" }),
    new MongoServerError({ code: 85, errmsg: "Index options conflict" }),
    new MongoNetworkError("connection interrupted"),
  ])("does not interpret Cosmos failures as native support: $message", async (error) => {
    const fixture = makeDb();
    fixture.command.mockRejectedValueOnce(error);

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toBe(error);
    expect(fixture.createIndex).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    new MongoServerError({ code: 11000, errmsg: "duplicate key" }),
    new MongoServerError({ code: 85, errmsg: "Index options conflict" }),
    new MongoNetworkError("connection interrupted"),
  ])("propagates native identity index creation failure: $message", async (error) => {
    const fixture = makeDb({ backend: "mongo" });
    fixture.createIndex.mockRejectedValueOnce(error);

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toBe(error);
    expect(fixture.createIndex).toHaveBeenCalledTimes(1);
  });

  it("propagates native email index creation failures and resumes safely on rerun", async () => {
    const fixture = makeDb({ backend: "mongo", exists: true, indexes: [idIndex, identityIndex] });
    const error = new MongoNetworkError("connection interrupted");
    fixture.createIndex.mockResolvedValueOnce("uniq_identity").mockRejectedValueOnce(error);

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toBe(error);
    await new CreateUsersCollection().up(fixture.db);
    expect(fixture.state.indexes).toContainEqual(emailIndex);
  });

  it.each([
    new MongoNetworkError("connection interrupted"),
    new MongoServerError({ code: 13, errmsg: "not authorized" }),
    new MongoServerError({ code: 85, errmsg: "Index options conflict" }),
  ])("propagates Cosmos email failures and resumes safely on rerun: $message", async (error) => {
    const fixture = makeDb({ exists: true, indexes: [idIndex, identityIndex] });
    fixture.createIndex.mockRejectedValueOnce(error);

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toBe(error);
    expect(fixture.createIndex).toHaveBeenCalledExactlyOnceWith({ email: 1 }, { name: "email" });
    await new CreateUsersCollection().up(fixture.db);
    expect(fixture.state.indexes).toContainEqual(cosmosEmailIndex);
    expect(fixture.drop).not.toHaveBeenCalled();
  });

  it.each([
    { ...cosmosEmailIndex, sparse: true },
    { ...cosmosEmailIndex, unique: true },
    { ...cosmosEmailIndex, key: { other: 1 } },
    { ...cosmosEmailIndex, partialFilterExpression: { email: { $exists: true } } },
  ])("rejects incompatible Cosmos email indexes without replacing them: %j", async (index) => {
    const fixture = makeDb({ exists: true, indexes: [idIndex, identityIndex, index] });

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/email/);

    expect(fixture.state.indexes).toEqual([idIndex, identityIndex, index]);
    expect(fixture.drop).not.toHaveBeenCalled();
    expect(fixture.collection().dropIndex).not.toHaveBeenCalled();
  });

  it("does not trust Cosmos email creation success without an actual index", async () => {
    const fixture = makeDb({ exists: true, indexes: [idIndex, identityIndex] });
    fixture.createIndex.mockResolvedValueOnce("email");

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/email/);
  });

  it("verifies native email index options instead of trusting createIndex success", async () => {
    const fixture = makeDb({ backend: "mongo", exists: true, indexes: [
      idIndex, identityIndex, { ...emailIndex, sparse: false },
    ] });

    await expect(new CreateUsersCollection().up(fixture.db)).rejects.toThrow(/email/);
  });

  it("keeps down non-destructive", async () => {
    const fixture = makeDb({ exists: true, indexes: [idIndex, identityIndex] });

    await new CreateUsersCollection().down(fixture.db);

    expect(fixture.command).not.toHaveBeenCalled();
    expect(fixture.collection).not.toHaveBeenCalled();
    expect(fixture.drop).not.toHaveBeenCalled();
  });
});
