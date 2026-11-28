// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostProcessor } from "../../../workers/post-processor/src/post-processor.js";
import type { RouteContext } from "../route-context.js";
import { registerReportsRoutes } from "./reports.js";

function buildApp() {
  let current = {
    _id: "request-1", projectId: "project-1",
    run: { _id: "run-1", status: "done", postProcessorStatus: "done" },
  };
  const insertOne = vi.fn().mockResolvedValue({});
  const sendMessage = vi.fn().mockResolvedValue({});
  const findOne = vi.fn(async (filter: Record<string, unknown>) => {
    const matches = Object.entries(filter).every(([key, value]) =>
      key.startsWith("run.")
        ? current.run[key.slice(4) as keyof typeof current.run] === value
        : current[key as keyof typeof current] === value,
    );
    return matches ? structuredClone(current) : null;
  });
  const app = express();
  app.use(express.json());
  registerReportsRoutes({
    app, registry: new OpenAPIRegistry(),
    requestCollection: { findOne },
    reportCollection: { insertOne },
    reportQueueClient: { sendMessage },
    reportTemplateCollection: {
      find: () => ({ toArray: async () => [{ id: "always", trigger: { type: "always" } }] }),
    },
  } as unknown as RouteContext);
  return {
    app, insertOne, sendMessage, findOne,
    replaceRun: (run: typeof current.run) => { current = { ...current, run }; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("automatic report attempt isolation", () => {
  it.each([
    { _id: "run-2", status: "done", postProcessorStatus: "done" },
    { _id: "run-1", status: "processing", postProcessorStatus: "done" },
    { _id: "run-1", status: "done", postProcessorStatus: "processing" },
  ])("rejects a superseded or unready attempt: %j", async (run) => {
    const fixture = buildApp();
    fixture.replaceRun(run);
    const response = await request(fixture.app).post("/api/v1/reports/trigger")
      .send({ requestId: "request-1", runId: "run-1" });
    expect(response.status).toBe(404);
    expect(fixture.insertOne).not.toHaveBeenCalled();
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });

  it("pins accepted reports even if a retry occurs during template evaluation", async () => {
    const fixture = buildApp();
    fixture.findOne.mockImplementationOnce(async () => {
      const original = {
        _id: "request-1", projectId: "project-1",
        run: { _id: "run-1", status: "done", postProcessorStatus: "done" },
      };
      fixture.replaceRun({ _id: "run-2", status: "pending", postProcessorStatus: "" });
      return original;
    });
    const response = await request(fixture.app).post("/api/v1/reports/trigger")
      .send({ requestId: "request-1", runId: "run-1" });
    expect(response.status).toBe(201);
    expect(fixture.insertOne).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-1", runId: "run-1", status: "pending",
    }));
    expect(fixture.sendMessage).toHaveBeenCalledOnce();
  });

  it.each([undefined, "run-1"])("accepts a ready attempt and pins it (runId: %s)", async (runId) => {
    const fixture = buildApp();
    const response = await request(fixture.app).post("/api/v1/reports/trigger")
      .send({ requestId: "request-1", runId });
    expect(response.status).toBe(201);
    expect(fixture.insertOne).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
  });

  it("rejects the worker trigger when retry happens after the successful completion stamp", async () => {
    const fixture = buildApp();
    const worker = new PostProcessor({
      mongoUri: "mongodb://localhost:27017", mongoDatabase: "test", mongoCollection: "requests",
      storageAccountName: "devstoreaccount1", storageConnectionString: "UseDevelopmentStorage=true",
      queueName: "post-processor", batchSize: 1, pollIntervalMs: 1000,
      redisHost: "localhost", redisPort: 6379, redisPassword: "", apiBaseUrl: "http://scope.test",
    });
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    (worker as any).collection = { updateOne };
    (worker as any).safeDeleteMessage = vi.fn().mockResolvedValue(undefined);
    worker.registerHandler({ type: "atif", process: vi.fn().mockResolvedValue(undefined) });
    let triggerStatus: number | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const response = await request(fixture.app).post("/api/v1/reports/trigger")
        .send(JSON.parse(init.body as string));
      triggerStatus = response.status;
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.fn(async (_level: string, message: string) => {
      if (message.startsWith("Post-processing complete")) {
        expect(updateOne).toHaveBeenCalledTimes(2);
        fixture.replaceRun({ _id: "run-2", status: "pending", postProcessorStatus: "" });
      }
    });
    await (worker as any).handleRequest(
      { _id: "request-1", run: { _id: "run-1", status: "done" } },
      { messageId: "message-1", popReceipt: "receipt-1" },
      { stop: () => "receipt-1" }, log,
      { type: "atif", requestId: "request-1", runId: "run-1" },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      requestId: "request-1", runId: "run-1",
    });
    expect(triggerStatus).toBe(404);
    expect(fixture.insertOne).not.toHaveBeenCalled();
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });
});
