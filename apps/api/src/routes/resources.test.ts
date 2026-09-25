// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Collection } from "mongodb";
import {
  ResourceResolver,
  ResourceRevisionStore,
  ResourceStore,
  type ResourceDocument,
  type ResourceRevisionDocument,
} from "shared";
import type { RouteContext } from "../route-context.js";
import { registerResourcesRoutes } from "./resources.js";

type UnknownRecord = Record<string, unknown>;

type Update<T> = {
  $set?: Partial<T>;
  $inc?: Partial<Record<keyof T, number>>;
};

function matches<T extends UnknownRecord>(doc: T, filter: UnknownRecord): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$or" && Array.isArray(condition)) {
      if (!condition.some((sub) => matches(doc, sub as UnknownRecord))) return false;
      continue;
    }
    const value = doc[key];
    if (typeof condition === "object" && condition !== null && "$exists" in condition) {
      const exists = value !== undefined;
      if ((condition as { $exists: boolean }).$exists !== exists) return false;
      continue;
    }
    if (typeof condition === "object" && condition !== null && "$lt" in condition) {
      if (typeof value !== "number") return false;
      if (!(value < (condition as { $lt: number }).$lt)) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function fakeCollection<T extends { _id: string }>(seed: T[] = []) {
  const docs = seed.map((doc) => ({ ...doc }));
  return {
    _docs: () => docs,
    async findOne(filter: UnknownRecord) {
      return docs.find((doc) => matches(doc as unknown as UnknownRecord, filter)) ?? null;
    },
    find(filter: UnknownRecord) {
      let result = docs.filter((doc) => matches(doc as unknown as UnknownRecord, filter));
      return {
        sort(sortSpec: UnknownRecord) {
          if (sortSpec.createdAt === -1) {
            result = [...result].sort((a, b) => {
              const aTime = a["createdAt" as keyof T] instanceof Date ? (a["createdAt" as keyof T] as Date).getTime() : 0;
              const bTime = b["createdAt" as keyof T] instanceof Date ? (b["createdAt" as keyof T] as Date).getTime() : 0;
              return bTime - aTime;
            });
          }
          if (sortSpec.revisionNumber === -1) {
            result = [...result].sort((a, b) => Number(b["revisionNumber" as keyof T] ?? 0) - Number(a["revisionNumber" as keyof T] ?? 0));
          }
          return this;
        },
        limit(limitValue: number) {
          result = result.slice(0, limitValue);
          return this;
        },
        async toArray() {
          return result;
        },
      };
    },
    async insertOne(doc: T) {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    },
    async updateOne(filter: UnknownRecord, update: Update<T>) {
      const doc = docs.find((candidate) => matches(candidate as unknown as UnknownRecord, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$inc) {
        for (const [key, amount] of Object.entries(update.$inc)) {
          const current = Number(doc[key as keyof T] ?? 0);
          (doc as unknown as Record<string, unknown>)[key] = current + Number(amount);
        }
      }
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(filter: UnknownRecord, update: Update<T>) {
      const doc = docs.find((candidate) => matches(candidate as unknown as UnknownRecord, filter));
      if (!doc) return null;
      if (update.$inc) {
        for (const [key, amount] of Object.entries(update.$inc)) {
          const current = Number(doc[key as keyof T] ?? 0);
          (doc as unknown as Record<string, unknown>)[key] = current + Number(amount);
        }
      }
      if (update.$set) Object.assign(doc, update.$set);
      return doc;
    },
    async updateMany(filter: UnknownRecord, update: Update<T>) {
      let modifiedCount = 0;
      for (const doc of docs) {
        if (matches(doc as unknown as UnknownRecord, filter)) {
          if (update.$set) Object.assign(doc, update.$set);
          modifiedCount += 1;
        }
      }
      return { matchedCount: modifiedCount, modifiedCount };
    },
    async deleteOne(filter: UnknownRecord) {
      const index = docs.findIndex((candidate) => matches(candidate as unknown as UnknownRecord, filter));
      if (index === -1) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(filter: UnknownRecord) {
      const before = docs.length;
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        if (matches(docs[index] as unknown as UnknownRecord, filter)) docs.splice(index, 1);
      }
      return { deletedCount: before - docs.length };
    },
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const resourceCollection = fakeCollection<ResourceDocument>();
  const revisionCollection = fakeCollection<ResourceRevisionDocument>();
  const resourceStore = new ResourceStore(resourceCollection as unknown as Collection<ResourceDocument>);
  const resourceRevisionStore = new ResourceRevisionStore(
    revisionCollection as unknown as Collection<ResourceRevisionDocument>,
    resourceStore
  );
  const ctx = {
    app,
    registry: new OpenAPIRegistry(),
    resourceStore,
    resourceRevisionStore,
    resourceResolver: new ResourceResolver(),
  } as unknown as RouteContext;
  registerResourcesRoutes(ctx);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return { app, resourceCollection, revisionCollection };
}

const createBody = {
  name: "GitHub Simulator",
  slug: "github-simulator",
  setup: { sh: "echo URL=http://localhost >> $SCOPE_SETUP_ENV" },
  teardown: { sh: "echo teardown" },
  exports: ["URL"],
};

describe("resource routes", () => {
  it("rejects duplicate slugs within a project but allows the same slug in another project", async () => {
    const { app, resourceCollection } = buildApp();

    const first = await request(app).post("/api/v1/resources?projectId=proj-a").send(createBody);
    const duplicate = await request(app).post("/api/v1/resources?projectId=proj-a").send(createBody);
    const otherProject = await request(app).post("/api/v1/resources?projectId=proj-b").send(createBody);

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatch(/already exists/);
    expect(otherProject.status).toBe(201);
    expect(resourceCollection._docs()).toHaveLength(2);
    expect(new Set(resourceCollection._docs().map((doc) => doc.projectId))).toEqual(new Set(["proj-a", "proj-b"]));
  });

  it("creates changed bodies as new immutable revisions without editing older revisions", async () => {
    const { app } = buildApp();

    const created = await request(app).post("/api/v1/resources?projectId=proj-a").send(createBody);
    expect(created.status).toBe(201);
    const firstRevision = created.body.firstRevision as ResourceRevisionDocument;

    const second = await request(app)
      .post("/api/v1/resources/github-simulator/revisions?projectId=proj-a")
      .send({ setup: { sh: "echo URL=http://changed >> $SCOPE_SETUP_ENV" }, exports: ["URL"] });
    expect(second.status).toBe(201);
    expect(second.body.revisionNumber).toBe(2);

    const fetchedFirst = await request(app).get("/api/v1/resources/github-simulator/revisions/1?projectId=proj-a");
    expect(fetchedFirst.status).toBe(200);
    expect(fetchedFirst.body._id).toBe(firstRevision._id);
    expect(fetchedFirst.body.setup.sh).toBe(createBody.setup.sh);
    expect(fetchedFirst.body.revisionNumber).toBe(1);
  });

  it("persists revision parameter declarations on create and rejects invalid declarations", async () => {
    const { app } = buildApp();

    const created = await request(app)
      .post("/api/v1/resources?projectId=proj-a")
      .send({
        ...createBody,
        parameters: [{ name: "REPO", required: true, example: "octo/api" }],
      });
    expect(created.status).toBe(201);
    expect(created.body.firstRevision.parameters).toEqual([
      { name: "REPO", required: true, example: "octo/api" },
    ]);

    const invalid = await request(app)
      .post("/api/v1/resources/github-simulator/revisions?projectId=proj-a")
      .send({
        setup: { sh: "echo URL=http://changed >> $SCOPE_SETUP_ENV" },
        exports: ["URL"],
        parameters: [{ name: "URL", required: false }],
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("both a parameter and an export");
  });

  it("does not expose mutation routes for immutable revisions", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/v1/resources?projectId=proj-a").send(createBody);
    expect(created.status).toBe(201);
    const revisionId = (created.body.firstRevision as ResourceRevisionDocument)._id;

    const patch = await request(app).patch(`/api/v1/resources/revisions/${revisionId}?projectId=proj-a`).send({ setup: { sh: "x" } });
    const put = await request(app).put(`/api/v1/resources/revisions/${revisionId}?projectId=proj-a`).send({ setup: { sh: "x" } });
    const del = await request(app).delete(`/api/v1/resources/revisions/${revisionId}?projectId=proj-a`);

    expect(patch.status).toBe(404);
    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
  });
});
