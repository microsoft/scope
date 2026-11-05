// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { CreateSubmissionIndexes } from "./migrations/034-create-submission-indexes.js";

function collection() {
  return {
    createIndex: vi.fn(async () => "index"),
  };
}

describe("migration 034: CreateSubmissionIndexes", () => {
  it("creates submission, history, dispatch, and recovery indexes", async () => {
    const submissions = collection();
    const submissionRuns = collection();
    const requests = collection();
    const db = {
      collection: vi.fn((name: string) => {
        if (name === "submissions") return submissions;
        if (name === "submission-runs") return submissionRuns;
        if (name === "requests") return requests;
        throw new Error(`Unexpected collection ${name}`);
      }),
    } as unknown as Db;

    await new CreateSubmissionIndexes().up(db);

    expect(submissions.createIndex).toHaveBeenCalledWith(
      { projectId: 1, createdAt: -1, _id: -1 },
      {},
    );
    expect(submissions.createIndex).toHaveBeenCalledWith(
      { "run.handlerStatus.pp-readout.status": 1 },
      {},
    );
    expect(submissionRuns.createIndex).toHaveBeenCalledWith(
      { submissionId: 1, attemptNumber: -1 },
      {},
    );
    expect(requests.createIndex).toHaveBeenCalledWith(
      { submissionFinalizedAt: 1 },
      {},
    );
    expect(requests.createIndex).toHaveBeenCalledWith(
      { submissionId: 1, projectId: 1, submissionRequestIndex: 1, _id: 1 },
      {},
    );
  });
});
