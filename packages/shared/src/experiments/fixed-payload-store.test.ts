// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import { describe, expect, it } from "vitest";
import { FixedPayloadStore } from "./fixed-payload-store.js";
import type { ExperimentRequestState } from "./types.js";

function request(index: number): ExperimentRequestState {
  return {
    requestId: `request-${index}`,
    runId: `run-${index}`,
    dependencies: [],
    blockers: [],
  };
}

function chunkCollection(failAt?: number) {
  const documents = new Map<string, Document>();
  let writes = 0;
  let nextFailure = failAt;
  function matches(document: Document, filter: Document): boolean {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = document[key];
      if (
        typeof expected === "object" &&
        expected !== null &&
        "$exists" in expected
      ) {
        return (
          (actual !== undefined) ===
          Boolean((expected as { $exists: unknown }).$exists)
        );
      }
      return actual === expected;
    });
  }
  return {
    documents,
    failOnWrite(write: number) {
      nextFailure = write;
    },
    writeCount() {
      return writes;
    },
    async updateOne(
      filter: Document,
      update: { $setOnInsert?: Document; $set?: Document },
    ) {
      writes += 1;
      if (writes === nextFailure) throw new Error("injected write failure");
      const id = String(filter._id);
      const existing = documents.get(id);
      if (!existing && update.$setOnInsert) {
        documents.set(id, structuredClone(update.$setOnInsert));
        return { matchedCount: 1, modifiedCount: 1 };
      }
      if (!existing || !matches(existing, filter)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (update.$set) Object.assign(existing, structuredClone(update.$set));
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOne(filter: Document) {
      return documents.get(String(filter._id)) ?? null;
    },
    async deleteMany(filter: { _id: { $in: string[] } }) {
      let deletedCount = 0;
      for (const id of filter._id.$in) {
        if (documents.delete(id)) deletedCount += 1;
      }
      return { deletedCount };
    },
  };
}

describe("FixedPayloadStore", () => {
  const identity = {
    projectId: "project-1",
    experimentId: "experiment-1",
    ownerId: "execution-1",
    generation: 1,
  };

  it("has identical logical reads for inline and chunked payloads", async () => {
    const entries = Array.from({ length: 60 }, (_, index) => request(index));
    const collection = chunkCollection();
    const store = new FixedPayloadStore(
      collection as unknown as Collection<Document>,
    );
    const inline = await store.prepareRequests({
      identity,
      entries,
      inlineDocument: (payload) => ({ payload }),
    });
    expect(inline.storage).toBe("inline");
    expect(await store.readRequests(identity, inline)).toEqual(entries);

    const chunked = await store.prepareRequests({
      identity: { ...identity, ownerId: "execution-2", generation: 2 },
      entries,
      inlineDocument: (payload) => ({
        payload,
        padding: "x".repeat(256 * 1024),
      }),
    });
    expect(chunked.storage).toBe("chunked");
    expect(
      await store.readRequests(
        { ...identity, ownerId: "execution-2", generation: 2 },
        chunked,
      ),
    ).toEqual(entries);
  });

  it("fails before returning a publishable descriptor on a partial write", async () => {
    const collection = chunkCollection(2);
    const store = new FixedPayloadStore(
      collection as unknown as Collection<Document>,
    );
    await expect(
      store.prepareRequests({
        identity,
        entries: Array.from({ length: 100 }, (_, index) => ({
          ...request(index),
          dependencies: [
            {
              handlerId: "obs",
              state: "ready",
              error: "x".repeat(1_800),
            },
          ],
        })),
        inlineDocument: (payload) => ({
          payload,
          padding: "x".repeat(256 * 1024),
        }),
      }),
    ).rejects.toThrow("injected write failure");
    expect(collection.documents.size).toBe(1);
  });

  it("rejects deterministic-id identity mismatches", async () => {
    const collection = chunkCollection();
    const store = new FixedPayloadStore(
      collection as unknown as Collection<Document>,
    );
    const payload = await store.prepareRequests({
      identity,
      entries: [request(1)],
      inlineDocument: (value) => ({
        value,
        padding: "x".repeat(256 * 1024),
      }),
    });
    expect(payload.storage).toBe("chunked");
    await expect(
      store.readRequests({ ...identity, projectId: "other-project" }, payload),
    ).rejects.toThrow(/identity mismatch/);
  });

  it.each(["inline", "chunked"] as const)(
    "applies the same logical projection update for %s payloads",
    async (storage) => {
      const collection = chunkCollection();
      const store = new FixedPayloadStore(
        collection as unknown as Collection<Document>,
      );
      const ownerId = `execution-${storage}`;
      const updateIdentity = { ...identity, ownerId };
      const entries = Array.from({ length: 70 }, (_, index) => request(index));
      const payload = await store.prepareRequests({
        identity: updateIdentity,
        entries,
        inlineDocument: (value) => ({
          value,
          ...(storage === "chunked"
            ? { padding: "x".repeat(256 * 1024) }
            : {}),
        }),
      });
      expect(payload.storage).toBe(storage);
      const projected = entries.map((entry, index) => ({
        ...entry,
        dependencies: [
          {
            handlerId: "observations",
            state: index % 2 === 0 ? ("ready" as const) : ("waiting" as const),
          },
        ],
        blockers:
          index % 2 === 0
            ? []
            : [
                {
                  handlerId: "observations",
                  reason: "dependency-not-ready" as const,
                },
              ],
      }));

      const result = await store.casUpdateRequests({
        identity: updateIdentity,
        payload,
        entries: projected,
      });

      expect(result.status).toBe("applied");
      if (result.status !== "applied") throw new Error("expected applied");
      expect(result.payload.storage).toBe(storage);
      expect(result.payload.payloadVersion).toBe(payload.payloadVersion + 1);
      if (payload.storage === "chunked" && result.payload.storage === "chunked") {
        expect(result.payload.bucketCount).toBe(payload.bucketCount);
        expect(result.payload.assignmentVersion).toBe(payload.assignmentVersion);
        expect(result.payload.chunkIds).toEqual(payload.chunkIds);
      }
      expect(
        await store.readRequests(updateIdentity, result.payload),
      ).toEqual(projected);
    },
  );

  it("reports and resumes a fault-injected partial chunk update", async () => {
    const collection = chunkCollection();
    const store = new FixedPayloadStore(
      collection as unknown as Collection<Document>,
    );
    const entries = Array.from({ length: 100 }, (_, index) => ({
      ...request(index),
      dependencies: [
        {
          handlerId: "observations",
          state: "waiting" as const,
          error: "x".repeat(1_500),
        },
      ],
    }));
    const payload = await store.prepareRequests({
      identity,
      entries,
      inlineDocument: (value) => ({
        value,
        padding: "x".repeat(256 * 1024),
      }),
    });
    expect(payload.storage).toBe("chunked");
    const projected = entries.map((entry) => ({
      ...entry,
      dependencies: [{ handlerId: "observations", state: "ready" as const }],
    }));
    collection.failOnWrite(collection.writeCount() + 2);

    const failed = await store.casUpdateRequests({
      identity,
      payload,
      entries: projected,
    });
    expect(failed).toMatchObject({
      status: "partial-failure",
      message: "injected write failure",
    });
    if (failed.status !== "partial-failure") {
      throw new Error("expected partial failure");
    }
    expect(failed.updatedChunkIds).toHaveLength(1);

    collection.failOnWrite(-1);
    const repaired = await store.casUpdateRequests({
      identity,
      payload,
      entries: projected,
    });
    expect(repaired.status).toBe("applied");
    if (repaired.status !== "applied") throw new Error("expected applied");
    expect(await store.readRequests(identity, repaired.payload)).toEqual(
      projected,
    );
  });

  it("rejects frozen or ownership-mismatched buckets without success", async () => {
    const collection = chunkCollection();
    const store = new FixedPayloadStore(
      collection as unknown as Collection<Document>,
    );
    const entries = [request(1)];
    const payload = await store.prepareRequests({
      identity,
      entries,
      inlineDocument: (value) => ({
        value,
        padding: "x".repeat(256 * 1024),
      }),
    });
    if (payload.storage !== "chunked") throw new Error("expected chunked");
    const chunk = collection.documents.get(payload.chunkIds[0]!);
    if (!chunk) throw new Error("missing chunk");
    chunk.frozenAt = new Date();

    await expect(
      store.casUpdateRequests({
        identity,
        payload,
        entries: [
          {
            ...entries[0]!,
            dependencies: [
              { handlerId: "observations", state: "ready" },
            ],
          },
        ],
      }),
    ).resolves.toMatchObject({ status: "stale", updatedChunkIds: [] });

    delete chunk.frozenAt;
    chunk.ownerId = "other-execution";
    await expect(
      store.casUpdateRequests({
        identity,
        payload,
        entries,
      }),
    ).resolves.toMatchObject({
      status: "invariant",
      updatedChunkIds: [],
    });
  });

  it("rejects an update that exceeds the fixed entry budget", async () => {
    const collection = chunkCollection();
    const store = new FixedPayloadStore(
      collection as unknown as Collection<Document>,
    );
    const payload = await store.prepareRequests({
      identity,
      entries: [request(1)],
      inlineDocument: (value) => ({ value }),
    });

    await expect(
      store.casUpdateRequests({
        identity,
        payload,
        entries: [
          {
            ...request(1),
            dependencies: [
              {
                handlerId: "observations",
                state: "failed",
                error: "x".repeat(4_096),
              },
            ],
          },
        ],
      }),
    ).resolves.toMatchObject({
      status: "invariant",
      updatedChunkIds: [],
    });
  });
});
