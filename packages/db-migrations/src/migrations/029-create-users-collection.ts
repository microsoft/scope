// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Create the `users` collection and its indexes.
 *
 * Backs API authentication (identity-only phase). Each user is keyed by the
 * IdP identity triple `(idp, idpTenant, idpSubject)`; the Scope User ID (`_id`)
 * is an app-owned UUID.
 *
 * - Unique compound `(idp, idpTenant, idpSubject)` — the durable identity key
 *   used by the JIT upsert lookup; guarantees one record per IdP principal.
 * - Non-unique index on optional `email`, sparse only on native MongoDB.
 *
 * Cosmos continuous backup requires unique indexes at collection creation.
 * Existing incompatible collections are never dropped or downgraded to a
 * non-unique identity index. Cosmos does not support sparse email indexes.
 */

import { MongoServerError, type Collection, type Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { getRetryAfterMs, sleep } from "../batch-update.js";

const USERS_COLLECTION = "users";
const IDENTITY_KEY = { idp: 1, idpTenant: 1, idpSubject: 1 } as const;
const MAX_ATTEMPTS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesKey(value: unknown, expected: Record<string, number>): boolean {
  return isRecord(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([field, direction]) => value[field] === direction);
}

async function readIndexes(users: Collection): Promise<Record<string, unknown>[]> {
  const indexes: unknown = await users.listIndexes().toArray();
  if (!Array.isArray(indexes) || !indexes.every(isRecord)) {
    throw new Error("[029] Invalid users index metadata");
  }
  return indexes;
}

async function useCosmosCollection(db: Db, exists: boolean): Promise<boolean> {
  const command = exists
    ? { customAction: "GetCollection", collection: USERS_COLLECTION }
    : {
      customAction: "CreateCollection",
      collection: USERS_COLLECTION,
      indexes: [
        { key: { _id: 1 }, name: "_id_1", unique: true },
        { key: IDENTITY_KEY, name: "uniq_identity", unique: true },
      ],
    };
  let response: unknown;
  try {
    response = await db.command(command);
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 59) return false;
    throw error;
  }
  if (!isRecord(response) || response.ok !== 1) {
    throw new Error(`[029] Invalid ${command.customAction} response`);
  }
  return true;
}

async function ensureUsersIndexes(db: Db): Promise<void> {
  const exists = await db.listCollections({ name: USERS_COLLECTION }, { nameOnly: true }).hasNext();
  const cosmos = await useCosmosCollection(db, exists);
  const users = db.collection(USERS_COLLECTION);

  if (!cosmos) {
    await users.createIndex(
      IDENTITY_KEY,
      { unique: true, name: "uniq_identity" },
    );
  }

  const indexes = await readIndexes(users);
  const validIdentity = indexes.some((index) =>
    index.name === "uniq_identity" &&
    matchesKey(index.key, IDENTITY_KEY) &&
    index.unique === true &&
    (index.sparse === undefined || index.sparse === false) &&
    index.partialFilterExpression === undefined &&
    (index.collation === undefined ||
      (isRecord(index.collation) && index.collation.locale === "simple")),
  );
  if (!validIdentity) {
    throw new Error(
      "[029] users.uniq_identity must be a unique, non-sparse, unfiltered index " +
      "on (idp, idpTenant, idpSubject) with simple collation." +
      (cosmos
        ? " CosmosDB continuous backup requires unique indexes at collection creation. " +
          "Operator-managed recovery is required; this migration will not drop, " +
          "recreate, or modify data in an incompatible users collection."
        : ""),
    );
  }
  console.log("  [029] Verified unique identity index on users");

  const validEmail = (index: Record<string, unknown>): boolean =>
    index.name === "email" &&
    matchesKey(index.key, { email: 1 }) &&
    (cosmos
      ? index.sparse === undefined || index.sparse === false
      : index.sparse === true) &&
    (index.unique === undefined || index.unique === false) &&
    index.partialFilterExpression === undefined;
  if (!indexes.some(validEmail)) {
    await users.createIndex(
      { email: 1 },
      cosmos ? { name: "email" } : { sparse: true, name: "email" },
    );
    const updatedIndexes = await readIndexes(users);
    if (!updatedIndexes.some(validEmail)) {
      throw new Error(`[029] users.email must be a ${cosmos ? "non-sparse" : "sparse"}, non-unique index on email`);
    }
  }
  console.log(`  [029] Verified ${cosmos ? "non-sparse email index on CosmosDB" : "sparse email index on native MongoDB"}`);
}

export class CreateUsersCollection implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await ensureUsersIndexes(db);
        return;
      } catch (error) {
        // Re-enter through collection/index discovery after throttling or a
        // competing creator. Never blindly retry DDL after a transport failure.
        if (!(error instanceof MongoServerError) ||
          (error.code !== 16500 && error.code !== 48) ||
          attempt >= MAX_ATTEMPTS - 1) {
          throw error;
        }
        const delay = error.code === 16500
          ? Math.max(getRetryAfterMs(error), 500 * 2 ** attempt)
          : 500 * 2 ** attempt;
        console.warn(`  [029] Retry ${attempt + 1}/${MAX_ATTEMPTS - 1} after code ${error.code}; waiting ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "  Skipping index/collection drop — drop manually if needed",
    );
  }
}