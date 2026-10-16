// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../route-context.js";
import { registerReportsRoutes } from "./reports.js";

describe("structured report download", () => {
  it("proxies the stored JSON artifact through the API", async () => {
    const app = express();
    app.use(express.json());
    const downloadJson = vi.fn().mockResolvedValue({
      meta: { submissionRunId: "submission-run-1" },
    });
    const ctx = {
      app,
      registry: new OpenAPIRegistry(),
      reportCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: "report-1",
          projectId: "project-1",
          submissionId: "submission-1",
          submissionRunId: "submission-run-1",
          status: "completed",
          structuredArtifact: {
            schemaId: "scope.submission-readout",
            schemaVersion: "1.0",
            contentType: "application/json",
            url: "https://storage.example/structured.json",
          },
          createdAt: new Date(),
        }),
      },
      blobStorage: { downloadJson },
    } as unknown as RouteContext;
    registerReportsRoutes(ctx);
    app.use((
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(500).json({ error: error.message }));

    const response = await request(app).get("/api/v1/reports/report-1/structured");

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain(
      "report-1.structured.json",
    );
    expect(response.body).toEqual({
      meta: { submissionRunId: "submission-run-1" },
    });
    expect(downloadJson).toHaveBeenCalledWith(
      "https://storage.example/structured.json",
    );
  });

  it("filters submission reports by the exact submission run", async () => {
    const app = express();
    app.use(express.json());
    const toArray = vi.fn().mockResolvedValue([{
      _id: "report-1",
      projectId: "project-1",
      submissionId: "submission-1",
      submissionRunId: "submission-run-1",
      status: "completed",
      createdAt: new Date("2026-10-13T12:00:00.000Z"),
    }]);
    const find = vi.fn(() => ({
      sort: vi.fn(() => ({ toArray })),
    }));
    const ctx = {
      app,
      registry: new OpenAPIRegistry(),
      reportCollection: { find },
      requestCollection: {
        find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
      },
    } as unknown as RouteContext;
    registerReportsRoutes(ctx);

    const response = await request(app).get(
      "/api/v1/reports?submissionId=submission-1&submissionRunId=submission-run-1",
    );

    expect(response.status).toBe(200);
    expect(find).toHaveBeenCalledWith({
      submissionId: "submission-1",
      submissionRunId: "submission-run-1",
    });
    expect(response.body[0]).toMatchObject({
      id: "report-1",
      submissionId: "submission-1",
      submissionRunId: "submission-run-1",
    });
  });
});
