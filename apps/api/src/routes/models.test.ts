// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { AgentDocument, ModelDocument } from "shared";
import type { RouteContext } from "../route-context.js";
import { useTestServer } from "../test-server.js";
import { registerModelsRoutes } from "./models.js";

describe("model sync default selection", () => {
  const app = express();
  app.use(express.json());
  const testServer = useTestServer(app);
  const modelCollection = { find: vi.fn(), findOne: vi.fn(), insertOne: vi.fn(), updateOne: vi.fn() };
  const agentCollection = { findOne: vi.fn(), updateOne: vi.fn() };
  registerModelsRoutes({ app, registry: new OpenAPIRegistry(), modelCollection, agentCollection } as unknown as RouteContext);

  beforeEach(() => {
    vi.resetAllMocks();
    modelCollection.find.mockReturnValue({ toArray: async () => [] });
    modelCollection.findOne.mockResolvedValue(null);
    agentCollection.findOne.mockResolvedValue({ _id: "copilot", defaultModel: "old-model" });
  });

  /** Exercise the public sync endpoint with the provider's full catalog. */
  function sync(models: Array<{ id: string }> = []) {
    return request(testServer()).post("/api/v1/models/sync").send({
      agentId: "copilot", provider: "github-copilot", models, scannedAt: "2026-01-01T00:00:00Z",
    });
  }

  it("removes the default when the final active model disappears", async () => {
    modelCollection.find.mockReturnValueOnce({ toArray: async () => [{ _id: "copilot:old-model", modelId: "old-model" }] });

    const result = await sync();

    expect(result.status).toBe(200);
    expect(result.body.removed).toEqual(["old-model"]);
    expect(agentCollection.updateOne).toHaveBeenCalledWith({ _id: "copilot" }, {
      $set: { supportedModels: [], updatedAt: expect.any(Date) },
      $unset: { defaultModel: "" },
    });
  });

  it("keeps a default still provided by another catalog", async () => {
    modelCollection.find.mockReturnValueOnce({ toArray: async () => [] });
    modelCollection.find.mockReturnValueOnce({ toArray: async () => [{ modelId: "old-model", provider: "another-provider" }] });

    expect((await sync()).status).toBe(200);

    expect(agentCollection.updateOne).toHaveBeenCalledWith({ _id: "copilot" }, {
      $set: { supportedModels: ["old-model"], updatedAt: expect.any(Date) },
    });
  });

  it("selects a default again when models return after an empty catalog", async () => {
    agentCollection.findOne.mockResolvedValue({ _id: "copilot", supportedModels: [] } satisfies Partial<AgentDocument>);
    const model = { modelId: "new-model", firstSeenAt: new Date("2026-01-01") } satisfies Partial<ModelDocument>;
    modelCollection.find.mockReturnValue({ toArray: async () => [model] });

    expect((await sync([{ id: "new-model" }])).status).toBe(200);

    expect(agentCollection.updateOne).toHaveBeenCalledWith({ _id: "copilot" }, {
      $set: { supportedModels: ["new-model"], defaultModel: "new-model", updatedAt: expect.any(Date) },
    });
  });
});
