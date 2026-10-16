// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Collection, Db } from "mongodb";
import type {
  RequestDocument,
  ReportDocument,
  ServiceHandlerDocument,
  SubmissionDocument,
  SubmissionRunHistoryDocument,
} from "shared";
import { computeSubmissionVectorFingerprint } from "shared";
import type { RouteContext } from "../route-context.js";
import { registerSubmissionsRoutes } from "./submissions.js";

function queryResult<T>(items: T[]) {
  return {
    sort: () => queryResult(items),
    limit: () => queryResult(items),
    toArray: async () => items,
  };
}

function buildApp(input: {
  requests: RequestDocument[];
  submission: SubmissionDocument;
  history?: SubmissionRunHistoryDocument[];
  reports?: ReportDocument[];
  logs?: Array<{
    timestamp: string;
    level: "info" | "warn" | "error" | "debug";
    source: string;
    message: string;
  }>;
}) {
  let submission = structuredClone(input.submission);
  const services: ServiceHandlerDocument[] = [
    {
      _id: "pp-atif",
      type: "post-process-handler",
      version: 1,
      queue: "post-processor",
      selector: "atif",
      autoBackfill: true,
      dependsOn: [],
    },
    {
      _id: "pp-observations",
      type: "post-process-handler",
      version: 1,
      queue: "post-processor",
      selector: "observations",
      autoBackfill: true,
      dependsOn: ["pp-atif"],
    },
  ];
  const submissionCollection = {
    findOne: vi.fn(async () => structuredClone(submission)),
    find: vi.fn(() => queryResult([structuredClone(submission)])),
    findOneAndUpdate: vi.fn(async (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
    ) => {
      if (filter["run._id"] !== submission.run._id) return null;
      submission = {
        ...submission,
        updatedAt: update.$set.updatedAt as Date,
        run: {
          ...submission.run,
          dependencyProjection: update.$set[
            "run.dependencyProjection"
          ] as SubmissionDocument["run"]["dependencyProjection"],
          blocking: update.$set[
            "run.blocking"
          ] as SubmissionDocument["run"]["blocking"],
          updatedAt: update.$set["run.updatedAt"] as Date,
        },
      };
      return structuredClone(submission);
    }),
  } as unknown as Collection<SubmissionDocument>;
  const db = {
    collection: vi.fn(() => ({
      find: vi.fn(() =>
        queryResult(services.filter((service) => service.type === "post-process-handler")),
      ),
      findOne: vi.fn(async () => null),
    })),
  } as unknown as Db;
  const ctx = {
    app: express(),
    registry: new OpenAPIRegistry(),
    db,
    requestCollection: {
      find: vi.fn(() => queryResult(input.requests)),
    } as unknown as Collection<RequestDocument>,
    reportCollection: {
      find: vi.fn((filter: Record<string, unknown>) =>
        queryResult((input.reports ?? []).filter((report) =>
          Object.entries(filter).every(([key, value]) =>
            report[key as keyof ReportDocument] === value
          )
        )),
      ),
      findOne: vi.fn(async (filter: Record<string, unknown>) =>
        (input.reports ?? []).find((report) =>
          Object.entries(filter).every(([key, value]) =>
            report[key as keyof ReportDocument] === value
          )
        ) ?? null
      ),
    } as unknown as Collection<ReportDocument>,
    submissionCollection,
    submissionRunsCollection: {
      find: vi.fn(() => queryResult(input.history ?? [])),
      findOne: vi.fn(async (filter: { _id: string }) =>
        (input.history ?? []).find((run) => run._id === filter._id) ?? null,
      ),
    } as unknown as Collection<SubmissionRunHistoryDocument>,
    blobStorage: {
      getLogEvents: vi.fn(async () => input.logs ?? []),
    },
  } as unknown as RouteContext;
  ctx.app.use(express.json());
  registerSubmissionsRoutes(ctx);
  ctx.app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(500).json({ error: error.message }),
  );
  return ctx.app;
}

describe("submission routes", () => {
  const requestDocument: RequestDocument = {
    _id: "request-1",
    projectId: "project-1",
    scenario: { task: "Implement feature", criteria: ["criterion"] },
    workerType: "worker",
    createdAt: new Date(),
    priority: 0,
    run: {
      _id: "run-1",
      attemptNumber: 1,
      status: "done",
      outcome: "failed",
      handlerStatus: {
        "pp-observations": { status: "done", version: 1 },
      },
    },
  };
  const submissionDocument: SubmissionDocument = {
    _id: "submission-1",
    submissionId: "submission-1",
    projectId: "project-1",
    requestIds: ["request-1"],
    createdAt: new Date(),
    run: {
      _id: "submission-run-1",
      attemptNumber: 1,
      vectorFingerprint: computeSubmissionVectorFingerprint([
        { requestId: "request-1", runId: "run-1" },
      ]),
      requests: [{ requestId: "request-1", runId: "run-1" }],
      createdAt: new Date(),
      dependencyProjection: [],
      blocking: [],
    },
  };

  it("returns readiness and the exact request/run vector", async () => {
    const response = await request(
      buildApp({
        requests: [requestDocument],
        submission: submissionDocument,
      }),
    ).get("/api/v1/submissions/submission-1");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      submissionId: "submission-1",
      submissionRunId: "submission-run-1",
      readiness: "ready",
      requests: [{ requestId: "request-1", runId: "run-1", outcome: "failed" }],
      dependencyProjection: [{
        requestId: "request-1",
        runId: "run-1",
        handlerId: "pp-observations",
        state: "ready",
      }],
    });
  });

  it("lists current and immutable archived attempts", async () => {
    const historical: SubmissionRunHistoryDocument = {
      ...submissionDocument.run,
      _id: "submission-run-0",
      attemptNumber: 1,
      reconcileAfter: new Date(),
      rollover: {
        nextSubmissionRunId: "internal-next",
        vectorFingerprint: "internal-fingerprint",
        requests: [{ requestId: "request-1", runId: "run-1" }],
        reason: "request-vector-changed",
        claimedAt: new Date(),
      },
      submissionId: "submission-1",
      projectId: "project-1",
    };
    const response = await request(
      buildApp({
        requests: [requestDocument],
        submission: submissionDocument,
        history: [historical],
      }),
    ).get("/api/v1/submissions/submission-1/runs");

    expect(response.status).toBe(200);
    expect(response.body.runs.map((run: { _id: string }) => run._id)).toEqual([
      "submission-run-1",
      "submission-run-0",
    ]);
    expect(response.body.runs[1]).not.toHaveProperty("reconcileAfter");
    expect(response.body.runs[1]).not.toHaveProperty("rollover");
  });

  it("rejects a manual retry targeting a stale submission run", async () => {
    const response = await request(
      buildApp({
        requests: [requestDocument],
        submission: submissionDocument,
      }),
    )
      .post("/api/v1/submissions/submission-1/retry")
      .send({ submissionRunId: "stale-submission-run" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: "Submission attempt is stale",
      submissionRunId: "submission-run-1",
    });
  });

  it("returns exact waiting request/run pairs when retry dependencies are not ready", async () => {
    const waitingRequest: RequestDocument = {
      ...requestDocument,
      run: {
        _id: "run-1",
        attemptNumber: 1,
        status: "done",
        handlerStatus: {},
      },
    };
    const response = await request(
      buildApp({
        requests: [waitingRequest],
        submission: submissionDocument,
      }),
    )
      .post("/api/v1/submissions/submission-1/retry")
      .send({ submissionRunId: "submission-run-1" });

    expect(response.status).toBe(409);
    expect(response.body.blocking).toEqual([
      {
        requestId: "request-1",
        runId: "run-1",
        handlerId: "pp-observations",
        reason: "dependency-not-ready",
      },
    ]);
  });

  it("lists current and historical reports for the submission", async () => {
    const currentReport: ReportDocument = {
      _id: "report-current",
      projectId: "project-1",
      submissionId: "submission-1",
      submissionRunId: "submission-run-1",
      status: "completed",
      content: "# Current",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const historicalReport: ReportDocument = {
      ...currentReport,
      _id: "report-historical",
      submissionRunId: "submission-run-0",
      content: "# Historical",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const response = await request(
      buildApp({
        requests: [requestDocument],
        submission: {
          ...submissionDocument,
          run: {
            ...submissionDocument.run,
            report: { reportId: "report-current" },
          },
        },
        reports: [currentReport, historicalReport],
      }),
    ).get("/api/v1/submissions/submission-1/reports");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject([
      {
        _id: "report-current",
        submissionRunId: "submission-run-1",
      },
      {
        _id: "report-historical",
        submissionRunId: "submission-run-0",
      },
    ]);
  });

  it("replays logs for the exact submission attempt", async () => {
    const response = await request(
      buildApp({
        requests: [requestDocument],
        submission: {
          ...submissionDocument,
          run: {
            ...submissionDocument.run,
            handlerStatus: {
              "pp-readout": { status: "done", version: 1 },
            },
          },
        },
        logs: [
          {
            timestamp: "2026-01-01T00:00:00.000Z",
            level: "info",
            source: "pp-readout",
            message: "Submission report completed",
          },
        ],
      }),
    ).get(
      "/api/v1/submissions/submission-1/runs/submission-run-1/logs?fromStart=true",
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain("Submission report completed");
    expect(response.text).toContain("event: done");
  });
});
