// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RouteContext } from "../route-context.js";
import { registerAgentsRoutes } from "./agents.js";

extendZodWithOpenApi(z);

const activeAgent = {
  _id: "active-agent",
  name: "Active agent",
  supportedModels: [],
  createdAt: new Date("2025-01-01T00:00:00Z"),
};

const deletedAgent = {
  _id: "deleted-agent",
  name: "Deleted agent",
  supportedModels: [],
  createdAt: new Date("2025-01-01T00:00:00Z"),
  deletedAt: new Date("2025-02-01T00:00:00Z"),
};

function matches(
  document: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (
      condition &&
      typeof condition === "object" &&
      "$exists" in condition
    ) {
      return (
        Object.hasOwn(document, key) ===
        (condition as { $exists: boolean }).$exists
      );
    }
    return document[key] === condition;
  });
}

function buildApp() {
  const documents = [activeAgent, deletedAgent];
  const agentCollection = {
    find: vi.fn((filter: Record<string, unknown>) => ({
      toArray: vi.fn(async () =>
        documents.filter((document) => matches(document, filter)),
      ),
    })),
    findOne: vi.fn(async (filter: Record<string, unknown>) =>
      documents.find((document) => matches(document, filter)) ?? null,
    ),
  } as unknown as RouteContext["agentCollection"];

  const app = express();
  app.use(express.json());
  registerAgentsRoutes({
    app,
    registry: new OpenAPIRegistry(),
    agentCollection,
  } as unknown as RouteContext);
  return app;
}

const versionPayload = {
  agentVersion: "v1",
  workerVersion: "v1-build",
  components: {},
  gitCommit: "abcdef0",
  buildTime: "20260101T000000Z",
  imageTag: "v1-build",
  queueName: "queue-target",
};

function buildVersionApp(documents: Array<Record<string, unknown>>) {
  const updateOne = vi.fn().mockResolvedValue({
    matchedCount: 1,
    modifiedCount: 1,
  });
  const agentCollection = {
    find: vi.fn((filter: Record<string, unknown>) => ({
      toArray: vi.fn(async () =>
        documents.filter((document) => matches(document, filter)),
      ),
    })),
    findOne: vi.fn(async (filter: Record<string, unknown>) =>
      documents.find((document) => matches(document, filter)) ?? null,
    ),
    updateOne,
  } as unknown as RouteContext["agentCollection"];

  const app = express();
  app.use(express.json());
  registerAgentsRoutes({
    app,
    registry: new OpenAPIRegistry(),
    agentCollection,
  } as unknown as RouteContext);
  return { app, updateOne, findOne: agentCollection.findOne };
}

describe("agent historical lookup", () => {
  it("excludes deleted agents from the list by default", async () => {
    const response = await request(buildApp()).get("/api/v1/agents");

    expect(response.status).toBe(200);
    expect(response.body.map((agent: { id: string }) => agent.id)).toEqual([
      activeAgent._id,
    ]);
  });

  it("includes deleted agents in the list when requested", async () => {
    const response = await request(buildApp()).get(
      "/api/v1/agents?includeDeleted=true",
    );

    expect(response.status).toBe(200);
    expect(response.body.map((agent: { id: string }) => agent.id)).toEqual([
      activeAgent._id,
      deletedAgent._id,
    ]);
  });

  it("retrieves a deleted agent only when requested", async () => {
    const hidden = await request(buildApp()).get(
      `/api/v1/agents/${deletedAgent._id}`,
    );
    const included = await request(buildApp()).get(
      `/api/v1/agents/${deletedAgent._id}?includeDeleted=true`,
    );

    expect(hidden.status).toBe(404);
    expect(included.status).toBe(200);
    expect(included.body).toMatchObject({
      id: deletedAgent._id,
      name: deletedAgent.name,
    });
  });

  describe("agent queue ownership", () => {
    it("rejects another exact target claiming an active queue", async () => {
      const target = {
        ...activeAgent,
        _id: "target-agent",
        versions: [],
      };
      const owner = {
        ...activeAgent,
        _id: "owner-agent",
        versions: [
          {
            ...versionPayload,
            agentVersion: "owner-v1",
            queueName: versionPayload.queueName,
            status: "active",
            createdAt: new Date(),
          },
        ],
      };
      const { app, updateOne } = buildVersionApp([target, owner]);

      const response = await request(app)
        .post(`/api/v1/agents/${target._id}/versions`)
        .send(versionPayload);

      expect(response.status).toBe(409);
      expect(response.body.error).toContain("owner-agent@owner-v1");
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("allows idempotent registration by the current exact target", async () => {
      const target = {
        ...activeAgent,
        _id: "target-agent",
        versions: [
          {
            ...versionPayload,
            status: "active",
            createdAt: new Date(),
          },
        ],
      };
      const { app, updateOne } = buildVersionApp([target]);

      const response = await request(app)
        .post(`/api/v1/agents/${target._id}/versions`)
        .send(versionPayload);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        agentVersion: versionPayload.agentVersion,
        queueName: versionPayload.queueName,
        status: "active",
      });
      expect(updateOne).toHaveBeenCalledTimes(1);
    });

    it("lets the latest version of an agent take over its queue", async () => {
      const target = {
        ...activeAgent,
        _id: "target-agent",
        versions: [
          {
            ...versionPayload,
            agentVersion: "v1",
            status: "active",
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      };
      const { app, updateOne } = buildVersionApp([target]);

      const response = await request(app)
        .post(`/api/v1/agents/${target._id}/versions`)
        .send({
          ...versionPayload,
          agentVersion: "v2",
          workerVersion: "v2-build",
        });

      expect(response.status).toBe(201);
      expect(updateOne).toHaveBeenCalledTimes(1);
      expect(updateOne.mock.calls[0][0]).toEqual(
        expect.objectContaining({ versions: target.versions }),
      );
      const update = updateOne.mock.calls[0][1] as {
        $set: { versions: Array<{ agentVersion: string; status: string }> };
      };
      expect(update.$set.versions).toEqual([
        expect.objectContaining({ agentVersion: "v1", status: "retired" }),
        expect.objectContaining({ agentVersion: "v2", status: "active" }),
      ]);
    });

    it("retries a same-agent takeover when versions change concurrently", async () => {
      const target = {
        ...activeAgent,
        _id: "target-agent",
        versions: [
          {
            ...versionPayload,
            agentVersion: "v1",
            status: "active",
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      };
      const concurrentlyUpdated = {
        ...target,
        versions: [
          {
            ...target.versions[0],
            status: "retired",
          },
          {
            ...versionPayload,
            agentVersion: "v2",
            workerVersion: "v2-build",
            status: "active",
            createdAt: new Date("2026-02-01T00:00:00Z"),
          },
        ],
      };
      const { app, updateOne, findOne } = buildVersionApp([target]);
      updateOne
        .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
        .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });
      findOne
        .mockResolvedValueOnce(target)
        .mockResolvedValueOnce(concurrentlyUpdated);

      const response = await request(app)
        .post(`/api/v1/agents/${target._id}/versions`)
        .send({
          ...versionPayload,
          agentVersion: "v3",
          workerVersion: "v3-build",
        });

      expect(response.status).toBe(201);
      expect(updateOne).toHaveBeenCalledTimes(2);
      expect(updateOne.mock.calls[1][0]).toEqual(
        expect.objectContaining({ versions: concurrentlyUpdated.versions }),
      );
      const retryUpdate = updateOne.mock.calls[1][1] as {
        $set: { versions: Array<{ agentVersion: string; status: string }> };
      };
      expect(retryUpdate.$set.versions).toEqual([
        expect.objectContaining({ agentVersion: "v1", status: "retired" }),
        expect.objectContaining({ agentVersion: "v2", status: "retired" }),
        expect.objectContaining({ agentVersion: "v3", status: "active" }),
      ]);
    });

    it("rejects reactivating a version whose queue has a new owner", async () => {
      const target = {
        ...activeAgent,
        _id: "target-agent",
        versions: [
          {
            ...versionPayload,
            status: "retired",
            createdAt: new Date(),
          },
        ],
      };
      const owner = {
        ...activeAgent,
        _id: "owner-agent",
        versions: [
          {
            ...versionPayload,
            agentVersion: "owner-v1",
            status: "active",
            createdAt: new Date(),
          },
        ],
      };
      const { app, updateOne } = buildVersionApp([target, owner]);

      const response = await request(app)
        .patch(`/api/v1/agents/${target._id}/versions/${versionPayload.agentVersion}`)
        .send({ status: "active" });

      expect(response.status).toBe(409);
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("lets an activated version take over its same-agent queue", async () => {
      const target = {
        ...activeAgent,
        _id: "target-agent",
        versions: [
          {
            ...versionPayload,
            agentVersion: "v1",
            status: "retired",
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
          {
            ...versionPayload,
            agentVersion: "v2",
            workerVersion: "v2-build",
            status: "active",
            createdAt: new Date("2026-02-01T00:00:00Z"),
          },
        ],
      };
      const { app, updateOne } = buildVersionApp([target]);

      const response = await request(app)
        .patch(`/api/v1/agents/${target._id}/versions/v1`)
        .send({ status: "active" });

      expect(response.status).toBe(200);
      expect(updateOne).toHaveBeenCalledTimes(1);
      const update = updateOne.mock.calls[0][1] as {
        $set: { versions: Array<{ agentVersion: string; status: string }> };
      };
      expect(update.$set.versions).toEqual([
        expect.objectContaining({ agentVersion: "v1", status: "active" }),
        expect.objectContaining({ agentVersion: "v2", status: "retired" }),
      ]);
    });

    it("rejects restoring an agent with conflicting active queue assignments", async () => {
      const deleted = {
        ...deletedAgent,
        _id: "restored-agent",
        versions: [
          {
            ...versionPayload,
            agentVersion: "v1",
            status: "active",
            createdAt: new Date(),
          },
          {
            ...versionPayload,
            agentVersion: "v2",
            status: "active",
            createdAt: new Date(),
          },
        ],
      };
      const { app, updateOne } = buildVersionApp([deleted]);

      const response = await request(app).post("/api/v1/agents").send({
        _id: deleted._id,
        name: "Restored agent",
      });

      expect(response.status).toBe(409);
      expect(updateOne).not.toHaveBeenCalled();
    });
  });

  it("returns 404 for an unknown agent when deleted agents are included", async () => {
    const response = await request(buildApp()).get(
      "/api/v1/agents/missing?includeDeleted=true",
    );

    expect(response.status).toBe(404);
  });
});
