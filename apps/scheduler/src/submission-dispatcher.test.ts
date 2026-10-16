// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Db } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RequestDocument,
  SubmissionDocument,
  SubmissionRunHistoryDocument,
} from "shared";
import { SubmissionDispatcher } from "./submission-dispatcher.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SubmissionDispatcher report template triggering", () => {
  it("claims and triggers the exact completed submission attempt once", async () => {
    const submission: SubmissionDocument = {
      _id: "submission-1",
      submissionId: "submission-1",
      projectId: "project-1",
      requestIds: ["request-1"],
      createdAt: new Date(),
      run: {
        _id: "submission-run-1",
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
    const findOneAndUpdate = vi.fn(async () => submission);
    const dispatcher = new SubmissionDispatcher(
      {} as Collection<RequestDocument>,
      {
        findOneAndUpdate,
        updateOne: vi.fn(),
      } as unknown as Collection<SubmissionDocument>,
      {} as Collection<SubmissionRunHistoryDocument>,
      { collection: vi.fn() } as unknown as Db,
      vi.fn(),
      30_000,
      30,
      "http://api.test",
    );
    const reconcile = vi.fn(async () => ({
      submission,
      readiness: "done" as const,
      rolled: false,
      dispatched: false,
    }));
    (
      dispatcher as unknown as {
        coordinator: { reconcile: typeof reconcile };
      }
    ).coordinator = { reconcile };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await (
      dispatcher as unknown as {
        reconcileAndTrigger: (submissionId: string) => Promise<void>;
      }
    ).reconcileAndTrigger("submission-1");

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "submission-1",
        "run._id": "submission-run-1",
      }),
      expect.any(Object),
      { returnDocument: "after" },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/v1/reports/trigger-submission",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          submissionId: "submission-1",
          submissionRunId: "submission-run-1",
        }),
      }),
    );
  });
});
