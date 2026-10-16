// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { ensureIndex } from "../cosmos-index-helpers.js";

const TAG = "034";

export class CreateSubmissionIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const submissions = db.collection("submissions");
    await ensureIndex(
      submissions,
      { projectId: 1, createdAt: -1, _id: -1 },
      {},
      "submissions",
      TAG,
    );
    await ensureIndex(
      submissions,
      { "run.handlerStatus.pp-readout.status": 1 },
      {},
      "submissions",
      TAG,
    );

    const submissionRuns = db.collection("submission-runs");
    await ensureIndex(
      submissionRuns,
      { submissionId: 1 },
      {},
      "submission-runs",
      TAG,
    );
    await ensureIndex(
      submissionRuns,
      { submissionId: 1, attemptNumber: -1 },
      {},
      "submission-runs",
      TAG,
    );

    const requests = db.collection("requests");
    await ensureIndex(
      requests,
      { submissionFinalizedAt: 1 },
      {},
      "requests",
      TAG,
    );
    await ensureIndex(
      requests,
      { submissionId: 1, projectId: 1, submissionRequestIndex: 1, _id: 1 },
      {},
      "requests",
      TAG,
    );
    console.log(`[${TAG}] Submission indexes complete`);
  }

  async down(_db: Db): Promise<void> {
    console.log(
      `[${TAG}-down] Skipping index changes - drop submission indexes manually if needed`,
    );
  }
}
