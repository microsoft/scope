// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import request from "supertest";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RouteContext } from "../route-context.js";
import { ExperimentStore, type ExperimentDocument } from "shared";
import {
  ExperimentLifecycleCoordinator,
  ExperimentLifecycleError,
} from "../experiment-lifecycle.js";
import { registerExperimentsRoutes } from "./experiments.js";

extendZodWithOpenApi(z);

function harness(overrides: Partial<RouteContext> = {}) {
  const app = express();
  app.use(express.json());
  const registry = new OpenAPIRegistry();
  registerExperimentsRoutes({
    app,
    registry,
    ...overrides,
  } as unknown as RouteContext);
  return { app, registry };
}

function emptyExperimentCollection() {
  let document: ExperimentDocument | undefined;
  return {
    updateOne: vi.fn(
      async (
        _filter: object,
        update: { $setOnInsert?: ExperimentDocument },
      ) => {
        document ??= structuredClone(update.$setOnInsert);
        return { acknowledged: true, matchedCount: document ? 1 : 0 };
      },
    ),
    findOne: vi.fn(async () =>
      document ? structuredClone(document) : null,
    ),
    findOneAndUpdate: vi.fn(
      async (
        _filter: object,
        update: {
          $set?: Partial<ExperimentDocument>;
          $inc?: { stateVersion?: number };
        },
      ) => {
        if (!document) return null;
        document = {
          ...document,
          ...update.$set,
          stateVersion:
            document.stateVersion + (update.$inc?.stateVersion ?? 0),
        };
        return structuredClone(document);
      },
    ),
  };
}

function generateDocument(registry: OpenAPIRegistry) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Experiment contract", version: "1.0.0" },
  });
}

describe("Experiment API contract", () => {
  it("scopes lifecycle operations and returns stable asynchronous progress", async () => {
    const lifecycleExperiment = {
      experimentId: "experiment-1",
      lifecycle: {
        operationId: "operation-1",
        phase: "deleting",
        stateVersion: 2,
        progress: {
          expectedRequests: 2,
          completedRequests: 1,
          expectedReports: 1,
          completedReports: 0,
        },
        blocking: [],
        deleteRequestedAt: new Date("2026-10-16T12:00:00.000Z"),
      },
    } as ExperimentDocument;
    const startDelete = vi
      .spyOn(ExperimentLifecycleCoordinator.prototype, "startDelete")
      .mockResolvedValue(lifecycleExperiment);
    const repair = vi
      .spyOn(ExperimentLifecycleCoordinator.prototype, "repair")
      .mockResolvedValue(lifecycleExperiment);
    const { app } = harness();

    const missingScope = await request(app)
      .delete("/api/v1/experiments/experiment-1");
    const started = await request(app)
      .delete("/api/v1/experiments/experiment-1?projectId=project-1");
    const status = await request(app)
      .get("/api/v1/experiments/experiment-1/lifecycle?projectId=project-1");

    expect(missingScope.status).toBe(400);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      experimentId: "experiment-1",
      operationId: "operation-1",
      phase: "deleting",
      progress: {
        expectedRequests: 2,
        completedRequests: 1,
      },
    });
    expect(status.status).toBe(200);
    expect(startDelete).toHaveBeenCalledWith("project-1", "experiment-1");
    expect(repair).toHaveBeenCalledWith("project-1", "experiment-1");

    startDelete.mockRestore();
    repair.mockRestore();
  });

  it("starts restore and exposes machine-readable lifecycle conflicts", async () => {
    const restoringExperiment = {
      experimentId: "experiment-1",
      lifecycle: {
        operationId: "operation-restore",
        phase: "restoring",
        stateVersion: 4,
        progress: {
          expectedRequests: 2,
          completedRequests: 0,
          expectedReports: 1,
          completedReports: 0,
        },
        blocking: [],
        deleteRequestedAt: new Date("2026-10-16T12:00:00.000Z"),
        restoreRequestedAt: new Date("2026-10-16T13:00:00.000Z"),
      },
    } as ExperimentDocument;
    const startRestore = vi
      .spyOn(ExperimentLifecycleCoordinator.prototype, "startRestore")
      .mockResolvedValueOnce(restoringExperiment)
      .mockRejectedValueOnce(
        new ExperimentLifecycleError(
          "Experiment restore conflicts with an active delete",
          409,
          "lifecycle-conflict",
          restoringExperiment.lifecycle,
        ),
      );
    const { app } = harness();

    const started = await request(app)
      .post("/api/v1/experiments/experiment-1/restore?projectId=project-1");
    const conflict = await request(app)
      .post("/api/v1/experiments/experiment-1/restore?projectId=project-1");

    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      operationId: "operation-restore",
      phase: "restoring",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: "lifecycle-conflict",
      operationId: "operation-restore",
      phase: "restoring",
    });

    startRestore.mockRestore();
  });

  it("requires project scope on root routes", async () => {
    const { app } = harness();

    const create = await request(app)
      .post("/api/v1/experiments")
      .send({
        mode: "empty",
        metadata: { name: "Empty experiment" },
        requests: [],
      });
    const list = await request(app).get("/api/v1/experiments");
    const get = await request(app).get("/api/v1/experiments/experiment-1");
    const retry = await request(app)
      .post("/api/v1/experiments/experiment-1/retry")
      .send({ experimentExecutionId: "execution-1" });

    expect(create.status).toBe(400);
    expect(list.status).toBe(400);
    expect(get.status).toBe(400);
    expect(retry.status).toBe(400);
  });

  it("requires and verifies project scope on execution routes", async () => {
    const findOne = vi.fn().mockResolvedValue(null);
    const { app } = harness({
      experimentCollection: { findOne },
    } as unknown as Partial<RouteContext>);

    const historyWithoutProject = await request(app).get(
      "/api/v1/experiments/experiment-1/executions",
    );
    const exactWithoutProject = await request(app).get(
      "/api/v1/experiments/experiment-1/executions/execution-1",
    );
    const wrongProject = await request(app).get(
      "/api/v1/experiments/experiment-1/executions?projectId=wrong-project",
    );
    const wrongProjectExact = await request(app).get(
      "/api/v1/experiments/experiment-1/executions/execution-1?projectId=wrong-project",
    );

    expect(historyWithoutProject.status).toBe(400);
    expect(exactWithoutProject.status).toBe(400);
    expect(wrongProject.status).toBe(404);
    expect(wrongProjectExact.status).toBe(404);
    expect(findOne).toHaveBeenCalledWith({
      _id: "experiment-1",
      projectId: "wrong-project",
      finalizedAt: { $exists: true },
      deletedAt: { $exists: false },
      "lifecycle.phase": {
        $nin: ["deleting", "deleted", "restoring"],
      },
    });
  });

  it("enforces explicit empty and compose modes", async () => {
    const { app } = harness();

    const emptyWithMembers = await request(app)
      .post("/api/v1/experiments?projectId=project-1")
      .send({
        mode: "empty",
        metadata: { name: "Invalid empty experiment" },
        requests: [{ scenario: { task: "task" }, workerType: "worker" }],
      });
    const composeWithoutMembers = await request(app)
      .post("/api/v1/experiments?projectId=project-1")
      .send({
        mode: "compose",
        metadata: { name: "Invalid composed experiment" },
        requests: [],
      });

    expect(emptyWithMembers.status).toBe(400);
    expect(composeWithoutMembers.status).toBe(400);
  });

  it("rejects removed Experiment metadata fields", async () => {
    const { app } = harness();

    const response = await request(app)
      .post("/api/v1/experiments?projectId=project-1")
      .send({
        mode: "empty",
        metadata: {
          name: "Tagged experiment",
          tags: ["nightly"],
        },
        requests: [],
      });

    expect(response.status).toBe(400);
  });

  it("creates an empty, visible, non-dispatchable experiment", async () => {
    const experimentCollection = emptyExperimentCollection();
    const { app } = harness({
      experimentCollection,
      experimentExecutionsCollection: {},
      experimentChunksCollection: {},
      requestCollection: {
        insertMany: vi.fn(),
        updateMany: vi.fn(),
      },
    } as unknown as Partial<RouteContext>);

    const response = await request(app)
      .post("/api/v1/experiments?projectId=project-1")
      .send({
        mode: "empty",
        metadata: { name: "Empty experiment" },
        requests: [],
      });

    expect(response.status).toBe(201);
    expect(response.body.requestIds).toEqual([]);
    expect(response.body.experiment).toMatchObject({
      projectId: "project-1",
      metadata: { name: "Empty experiment" },
      revision: { memberCount: 0 },
      currentExecution: {
        readiness: "empty",
        blockers: [],
        progress: {},
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /stateVersion|claimToken|vectorFingerprint|storageProfile|rollover/,
    );
  });

  it("inserts composed requests before publishing their exact revision", async () => {
    const experimentCollection = emptyExperimentCollection();
    const insertMany = vi.fn().mockResolvedValue({
      acknowledged: true,
      insertedCount: 1,
    });
    const updateMany = vi.fn().mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    });
    const { app } = harness({
      experimentCollection,
      experimentExecutionsCollection: {},
      experimentChunksCollection: {},
      requestCollection: { insertMany, updateMany },
      taskPromptStore: {
        findOrCreate: vi.fn().mockResolvedValue({ _id: "prompt-1" }),
      },
      blobStorage: {
        getLogsBlobUrl: vi.fn(
          (path: string) => `https://storage.invalid/${path}`,
        ),
      },
    } as unknown as Partial<RouteContext>);

    const response = await request(app)
      .post("/api/v1/experiments?projectId=project-1")
      .send({
        mode: "compose",
        metadata: { name: "One request" },
        requests: [
          {
            scenario: { task: "Build it", criteria: ["works"] },
            workerType: "coder",
          },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.requestIds).toHaveLength(1);
    const inserted = insertMany.mock.calls[0]?.[0]?.[0];
    expect(inserted).toMatchObject({
      projectId: "project-1",
      experimentId: response.body.experiment.experimentId,
      experimentExpectedRequestCount: 1,
      experimentRequestIndex: 0,
      experimentInitialRunId: expect.any(String),
      run: {
        _id: expect.any(String),
        status: "pending",
      },
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        experimentId: response.body.experiment.experimentId,
      }),
      { $set: { experimentFinalizedAt: expect.any(Date) } },
    );
  });

  it("publishes only the canonical routes and public execution fields", () => {
    const { registry } = harness();
    const document = generateDocument(registry);

    expect(Object.keys(document.paths ?? {}).sort()).toEqual([
      "/api/v1/experiments",
      "/api/v1/experiments/{id}",
      "/api/v1/experiments/{id}/executions",
      "/api/v1/experiments/{id}/executions/{experimentExecutionId}",
      "/api/v1/experiments/{id}/executions/{experimentExecutionId}/logs",
      "/api/v1/experiments/{id}/executions/{experimentExecutionId}/reports",
      "/api/v1/experiments/{id}/executions/{experimentExecutionId}/reports/{reportId}/structured",
      "/api/v1/experiments/{id}/executions/{experimentExecutionId}/reports/{templateId}/retry",
      "/api/v1/experiments/{id}/lifecycle",
      "/api/v1/experiments/{id}/report-templates",
      "/api/v1/experiments/{id}/requests",
      "/api/v1/experiments/{id}/restore",
      "/api/v1/experiments/{id}/retry",
    ]);
    expect(document.paths).not.toHaveProperty("/api/v1/submissions");

    const executionSchema = document.components?.schemas
      ?.ExperimentExecutionResponse;
    expect(
      JSON.stringify(document.components?.schemas?.CreateExperimentInput),
    ).not.toContain('"tags"');
    expect(
      JSON.stringify(document.components?.schemas?.ExperimentResponse),
    ).not.toContain('"tags"');
    expect(executionSchema).toMatchObject({
      type: "object",
      properties: {
        experimentExecutionId: { type: "string" },
        readiness: expect.any(Object),
        blockers: expect.any(Object),
        progress: expect.any(Object),
        reportTemplates: expect.any(Object),
        report: expect.any(Object),
        supersededByExperimentExecutionId: { type: "string" },
      },
    });
    expect(JSON.stringify(executionSchema)).not.toMatch(
      /claimToken|stateVersion|vectorFingerprint|storageProfile/,
    );
  });

  it("lists reports for one exact current or archived execution", async () => {
      const execution = {
        experimentExecutionId: "execution-2",
        attemptNumber: 2,
        version: 4,
        requests: {
          storage: "inline" as const,
          entryCount: 0,
          payloadFingerprint: "payload",
          payloadVersion: 1,
          entries: [],
        },
        vectorFingerprint: "vector",
        handlerSummary: {},
        blocking: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const getExecution = vi
        .spyOn(ExperimentStore.prototype, "getExecution")
        .mockResolvedValue(execution);
      vi.spyOn(ExperimentStore.prototype, "get").mockResolvedValue({
        _id: "experiment-1",
        projectId: "project-1",
      } as ExperimentDocument);
      const toArray = vi.fn().mockResolvedValue([{
        _id: "report-1",
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-2",
        status: "completed",
        createdAt: new Date(),
      }]);
      const find = vi.fn(() => ({
        sort: vi.fn(() => ({ toArray })),
      }));
      const { app } = harness({
        experimentCollection: {},
        experimentExecutionsCollection: {},
        experimentChunksCollection: {},
        reportCollection: { find },
      } as unknown as Partial<RouteContext>);

      const response = await request(app).get(
        "/api/v1/experiments/experiment-1/executions/execution-2/reports?projectId=project-1",
      );

      expect(response.status).toBe(200);
      expect(getExecution).toHaveBeenCalledWith({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-2",
        includeDeleted: false,
      });
      expect(find).toHaveBeenCalledWith({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-2",
        deletedAt: { $exists: false },
      });
      expect(response.body).toEqual([
        expect.objectContaining({
          id: "report-1",
          experimentExecutionId: "execution-2",
        }),
      ]);
  });

  it("retrieves structured JSON only through the exact execution identity", async () => {
      const findOne = vi.fn().mockResolvedValue({
        _id: "report-1",
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-2",
        status: "completed",
        structuredArtifact: {
          schemaId: "scope.experiment-readout",
          schemaVersion: "1.0",
          contentType: "application/json",
          url: "https://storage.invalid/readout.json",
        },
        createdAt: new Date(),
      });
      const downloadJson = vi.fn().mockResolvedValue({
        meta: {
          experimentId: "experiment-1",
          experimentExecutionId: "execution-2",
        },
      });
      const { app } = harness({
        reportCollection: { findOne },
        blobStorage: { downloadJson },
      } as unknown as Partial<RouteContext>);

      const response = await request(app).get(
        "/api/v1/experiments/experiment-1/executions/execution-2/reports/report-1/structured?projectId=project-1",
      );

      expect(response.status).toBe(200);
      expect(findOne).toHaveBeenCalledWith({
        _id: "report-1",
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-2",
      });
      expect(downloadJson).toHaveBeenCalledWith(
        "https://storage.invalid/readout.json",
      );
      expect(response.body.meta).toEqual({
        experimentId: "experiment-1",
        experimentExecutionId: "execution-2",
      });
  });
});
