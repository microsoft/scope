// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import express from "express";
import type { Collection } from "mongodb";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type {
  ReportDocument,
  ReportTemplateDocument,
  SubmissionDocument,
} from "shared";
import type { RouteContext } from "../route-context.js";
import { registerReportsRoutes } from "./reports.js";

function queryResult<T>(items: T[]) {
  return {
    sort: () => queryResult(items),
    toArray: async () => items,
  };
}

function buildApp(input: {
  existingReport?: ReportDocument;
  submissionRunId?: string;
}) {
  const submission: SubmissionDocument = {
    _id: "submission-1",
    submissionId: "submission-1",
    projectId: "project-1",
    requestIds: ["request-1"],
    createdAt: new Date(),
    run: {
      _id: input.submissionRunId ?? "submission-run-1",
      attemptNumber: 1,
      vectorFingerprint: "vector",
      requests: [{ requestId: "request-1", runId: "run-1" }],
      dependencyProjection: [],
      blocking: [],
      handlerStatus: {
        "pp-readout": { status: "done", version: 1 },
      },
      report: { reportId: "readout-report" },
      createdAt: new Date(),
    },
  };
  const template: ReportTemplateDocument = {
    _id: "template-document-1",
    projectId: "project-1",
    id: "executive-summary",
    name: "Executive Summary",
    subject: "submission",
    userPrompt: "Summarize this submission.",
    trigger: { type: "always" },
    createdAt: new Date(),
  };
  const insertOne = vi.fn(async () => ({ acknowledged: true }));
  const sendMessage = vi.fn(async () => ({ messageId: "queued" }));
  const ctx = {
    app: express(),
    registry: new OpenAPIRegistry(),
    submissionCollection: {
      findOne: vi.fn(async (filter: Record<string, unknown>) =>
        filter._id === submission._id &&
        filter["run._id"] === submission.run._id
          ? submission
          : null,
      ),
    } as unknown as Collection<SubmissionDocument>,
    reportTemplateCollection: {
      find: vi.fn(() => queryResult([template])),
    } as unknown as Collection<ReportTemplateDocument>,
    reportCollection: {
      findOne: vi.fn(async () => input.existingReport ?? null),
      insertOne,
    } as unknown as Collection<ReportDocument>,
    reportQueueClient: { sendMessage },
  } as unknown as RouteContext;
  ctx.app.use(express.json());
  registerReportsRoutes(ctx);
  ctx.app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(500).json({ error: error.message }),
  );
  return { app: ctx.app, insertOne, sendMessage };
}

describe("submission report template trigger", () => {
  it("queues one report for each matching submission template", async () => {
    const { app, insertOne, sendMessage } = buildApp({});

    const response = await request(app)
      .post("/api/v1/reports/trigger-submission")
      .send({
        submissionId: "submission-1",
        submissionRunId: "submission-run-1",
      });

    expect(response.status).toBe(201);
    expect(response.body.triggered).toBe(1);
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: "submission-1",
        submissionRunId: "submission-run-1",
        templateId: "executive-summary",
        status: "pending",
      }),
    );
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("rejects a stale submission attempt", async () => {
    const { app, insertOne } = buildApp({
      submissionRunId: "submission-run-current",
    });

    const response = await request(app)
      .post("/api/v1/reports/trigger-submission")
      .send({
        submissionId: "submission-1",
        submissionRunId: "submission-run-stale",
      });

    expect(response.status).toBe(404);
    expect(insertOne).not.toHaveBeenCalled();
  });

  it("does not create a duplicate report for the same attempt and template", async () => {
    const { app, insertOne, sendMessage } = buildApp({
      existingReport: {
        _id: "existing-report",
        projectId: "project-1",
        submissionId: "submission-1",
        submissionRunId: "submission-run-1",
        templateId: "executive-summary",
        status: "completed",
        createdAt: new Date(),
      },
    });

    const response = await request(app)
      .post("/api/v1/reports/trigger-submission")
      .send({
        submissionId: "submission-1",
        submissionRunId: "submission-run-1",
      });

    expect(response.status).toBe(201);
    expect(response.body.triggered).toBe(0);
    expect(insertOne).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
