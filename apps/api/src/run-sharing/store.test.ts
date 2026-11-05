// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FULL_SHARE_CONTENT, SUMMARY_SHARE_CONTENT } from "shared/run-sharing";
import { RunShareStore } from "./store.js";
import { memoryShares } from "./test-fixtures.js";

const publisher = { requestId: "request-1", runId: "attempt-1", projectId: "project-1", createdBy: "user-1" };
const policy = { label: "Example", content: { ...SUMMARY_SHARE_CONTENT }, expiresAt: null };

describe("RunShareStore", () => {
  it("stores only a hash and returns the secret only at creation/rotation", async () => {
    const { collection, documents } = memoryShares();
    const store = new RunShareStore(collection);
    const created = await store.create(publisher, policy);
    const token = created.path.split("#")[1];
    expect(token.split(".")[1]).toHaveLength(43);
    const saved = documents.get(created.share.id);
    expect(saved?.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(await store.resolve(token)).toBe(saved);
    const list = await store.list(publisher);
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain("createdBy");
    const rotated = await store.rotate(publisher, created.share.id);
    expect(rotated?.path).not.toBe(created.path);
    expect(await store.resolve(token)).toBeNull();
    expect(await store.resolve(rotated!.path.split("#")[1])).not.toBeNull();
  });

  it("makes revocation, expiry, and caller ownership authoritative", async () => {
    const { collection } = memoryShares();
    const store = new RunShareStore(collection);
    const created = await store.create(publisher, policy);
    const token = created.path.split("#")[1];
    const other = { ...publisher, createdBy: "other-user" };
    expect(await store.list(other)).toEqual({ data: [], next: null });
    expect(await store.update(other, created.share.id, { label: "stolen" })).toBeNull();
    expect(await store.rotate(other, created.share.id)).toBeNull();
    expect(await store.revoke(other, created.share.id)).toBeNull();
    await store.update(publisher, created.share.id, { expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await store.resolve(token)).toBeNull();
    await store.update(publisher, created.share.id, { expiresAt: null, content: { ...FULL_SHARE_CONTENT } });
    expect(await store.resolve(token)).not.toBeNull();
    await store.revoke(publisher, created.share.id);
    expect(await store.resolve(token)).toBeNull();
    expect(await store.update(publisher, created.share.id, { expiresAt: null })).toBeNull();
    expect(await store.rotate(publisher, created.share.id)).toBeNull();
  });

  it("rejects malformed tokens without a database read and scopes valid lookups by _id and hash", async () => {
    const { collection } = memoryShares();
    const store = new RunShareStore(collection);
    expect(await store.resolve("guess")).toBeNull();
    expect(collection.findOne).not.toHaveBeenCalled();
    const created = await store.create(publisher, policy);
    await store.resolve(created.path.split("#")[1]);
    expect(collection.findOne).toHaveBeenCalledWith(expect.objectContaining({
      _id: created.share.id, tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), revokedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: expect.any(Date) } }],
    }));
  });

  it("paginates management records without exposing secrets", async () => {
    const { collection } = memoryShares();
    const store = new RunShareStore(collection);
    for (let index = 0; index < 51; index++) await store.create(publisher, policy);
    const first = await store.list(publisher);
    expect(first.data).toHaveLength(50);
    expect(first.next).toBe(first.data[49].id);
    const second = await store.list(publisher, first.next!);
    expect(second.data).toHaveLength(1);
    expect(second.next).toBeNull();
    expect(first.data.some((item) => item.id === second.data[0].id)).toBe(false);
  });

  it("does not retry an ambiguous network write", async () => {
    const { collection } = memoryShares();
    vi.mocked(collection.insertOne).mockRejectedValue(new Error("Connection reset"));
    await expect(new RunShareStore(collection).create(publisher, policy)).rejects.toThrow("Connection reset");
    expect(collection.insertOne).toHaveBeenCalledTimes(1);
  });
});
