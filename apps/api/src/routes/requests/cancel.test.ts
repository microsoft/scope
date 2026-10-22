// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Unit tests for the cancel endpoints:
 *   - POST /api/v1/requests/:id/cancel
 *   - POST /api/v1/requests/bulk-cancel
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockRouteAuthorization } from "../../test-helpers.js";
import express, { type Express } from "express";
import request from "supertest";
import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

import { registerRequestsCancelRoutes } from "./cancel.js";

// ─── In-memory Mongo collection ─────────────────────────────────────────────

function makeRequestCollection() {
  const docs = new Map<string, any>();
  return {
    docs,
    findOne: vi.fn(async (filter: any) => {
      const id = filter?._id;
      if (!id) return null;
      const doc = docs.get(id);
      if (!doc) return null;
      if (filter.deletedAt?.$exists === false && doc.deletedAt) return null;
      return doc;
    }),
    updateOne: vi.fn(async (filter: any, update: any) => {
      const doc = docs.get(filter._id);
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      const allowedStatuses = filter["run.status"]?.$in;
      if (allowedStatuses && !allowedStatuses.includes(doc.run?.status)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (filter.deletedAt?.$exists === false && doc.deletedAt) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      // Apply $set
      if (update.$set) {
        for (const [key, value] of Object.entries(update.$set)) {
          const parts = key.split(".");
          let target = doc;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!target[parts[i]]) target[parts[i]] = {};
            target = target[parts[i]];
          }
          target[parts[parts.length - 1]] = value;
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  };
}

// ─── Mock heartbeat store ───────────────────────────────────────────────────

function makeHeartbeatStore() {
  return {
    setCancelled: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    isCancelled: vi.fn(async () => false),
    set: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    deleteCancelled: vi.fn(async () => {}),
    subscribeCancellation: vi.fn(() => () => {}),
  };
}

// ─── App harness ────────────────────────────────────────────────────────────

function buildApp(
  reqCollection: ReturnType<typeof makeRequestCollection>,
  heartbeatStore: ReturnType<typeof makeHeartbeatStore>,
): Express {
  const app = express();
  mockRouteAuthorization(app);
  app.use(express.json());

  const ctx: any = {
    app,
    registry: new OpenAPIRegistry(),
    requestCollection: reqCollection,
    heartbeatStore,
  };

  registerRequestsCancelRoutes(ctx);
  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeDoc(overrides: Partial<{ _id: string; status: string; runId: string; deletedAt: Date }> = {}) {
  const { _id = "req-1", status = "processing", runId = "run-1", deletedAt } = overrides;
  const doc: any = {
    _id,
    run: { _id: runId, status },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (deletedAt) doc.deletedAt = deletedAt;
  return doc;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/v1/requests/:id/cancel", () => {
  let reqCollection: ReturnType<typeof makeRequestCollection>;
  let heartbeatStore: ReturnType<typeof makeHeartbeatStore>;
  let app: Express;

  beforeEach(() => {
    reqCollection = makeRequestCollection();
    heartbeatStore = makeHeartbeatStore();
    app = buildApp(reqCollection, heartbeatStore);
  });

  it("cancels a processing request and signals the worker", async () => {
    reqCollection.docs.set("req-1", makeDoc({ status: "processing" }));

    const res = await request(app).post("/api/v1/requests/req-1/cancel").send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: "req-1",
      previousStatus: "processing",
      status: "done",
      outcome: "failed",
    });
    expect(heartbeatStore.setCancelled).toHaveBeenCalledWith("run-1");
    expect(heartbeatStore.delete).toHaveBeenCalledWith("run-1");
  });

  it("cancels a pending request without signalling the worker", async () => {
    reqCollection.docs.set("req-1", makeDoc({ status: "pending" }));

    const res = await request(app).post("/api/v1/requests/req-1/cancel").send();

    expect(res.status).toBe(200);
    expect(res.body.previousStatus).toBe("pending");
    expect(heartbeatStore.setCancelled).not.toHaveBeenCalled();
  });

  it("cancels a queued request without signalling the worker", async () => {
    reqCollection.docs.set("req-1", makeDoc({ status: "queued" }));

    const res = await request(app).post("/api/v1/requests/req-1/cancel").send();

    expect(res.status).toBe(200);
    expect(res.body.previousStatus).toBe("queued");
    expect(heartbeatStore.setCancelled).not.toHaveBeenCalled();
  });

  it("returns 404 for non-existent request", async () => {
    const res = await request(app).post("/api/v1/requests/nope/cancel").send();
    expect(res.status).toBe(404);
  });

  it("returns 409 for already-done request", async () => {
    reqCollection.docs.set("req-1", makeDoc({ status: "done" }));

    const res = await request(app).post("/api/v1/requests/req-1/cancel").send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("terminal status");
  });

  it("returns 409 for paused request", async () => {
    reqCollection.docs.set("req-1", makeDoc({ status: "paused" }));

    const res = await request(app).post("/api/v1/requests/req-1/cancel").send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused");
  });

  it("returns 404 for soft-deleted request", async () => {
    reqCollection.docs.set("req-1", makeDoc({ deletedAt: new Date() }));

    const res = await request(app).post("/api/v1/requests/req-1/cancel").send();

    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/requests/bulk-cancel", () => {
  let reqCollection: ReturnType<typeof makeRequestCollection>;
  let heartbeatStore: ReturnType<typeof makeHeartbeatStore>;
  let app: Express;

  beforeEach(() => {
    reqCollection = makeRequestCollection();
    heartbeatStore = makeHeartbeatStore();
    app = buildApp(reqCollection, heartbeatStore);
  });

  it("cancels multiple requests and reports results", async () => {
    reqCollection.docs.set("req-1", makeDoc({ _id: "req-1", status: "processing", runId: "run-1" }));
    reqCollection.docs.set("req-2", makeDoc({ _id: "req-2", status: "pending", runId: "run-2" }));
    reqCollection.docs.set("req-3", makeDoc({ _id: "req-3", status: "done", runId: "run-3" }));

    const res = await request(app)
      .post("/api/v1/requests/bulk-cancel")
      .send({ ids: ["req-1", "req-2", "req-3", "req-missing"] });

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(2);
    expect(res.body.skipped).toBe(2);
    expect(res.body.results).toHaveLength(4);

    const r1 = res.body.results.find((r: any) => r.id === "req-1");
    expect(r1.cancelled).toBe(true);
    expect(r1.previousStatus).toBe("processing");

    const r2 = res.body.results.find((r: any) => r.id === "req-2");
    expect(r2.cancelled).toBe(true);

    const r3 = res.body.results.find((r: any) => r.id === "req-3");
    expect(r3.cancelled).toBe(false);
    expect(r3.error).toContain("terminal status");

    const rMissing = res.body.results.find((r: any) => r.id === "req-missing");
    expect(rMissing.cancelled).toBe(false);
    expect(rMissing.error).toBe("Not found");

    // Only processing run gets signalled
    expect(heartbeatStore.setCancelled).toHaveBeenCalledTimes(1);
    expect(heartbeatStore.setCancelled).toHaveBeenCalledWith("run-1");
  });

  it("validates body requires at least one id", async () => {
    const res = await request(app)
      .post("/api/v1/requests/bulk-cancel")
      .send({ ids: [] });

    expect(res.status).toBe(400);
  });
});
