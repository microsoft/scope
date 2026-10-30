// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { buildTaxonomyReadout } from "./taxonomy-readout.js";

describe("buildTaxonomyReadout", () => {
  it("preserves all three exact request/run identities in one readout", async () => {
    const pairs = [1, 2, 3].map((number) => ({
      requestId: `request-${number}`,
      runId: `run-${number}`,
      dependencies: [],
      blockers: [],
    }));
    const bodies = new Map(
      pairs.map((pair) => {
        const body = Buffer.from(
          JSON.stringify({
            run: {
              id: pair.runId,
              scenario: { id: "scenario", label: "Scenario" },
              profile: { id: "profile", label: "Profile" },
            },
            results: [],
          }),
          "utf8",
        );
        return [pair.runId, body] as const;
      }),
    );
    const requestCollection = {
      findOne: vi.fn(async ({ _id }: { _id: string }) => {
        const pair = pairs.find((candidate) => candidate.requestId === _id)!;
        const body = bodies.get(pair.runId)!;
        return {
          _id,
          projectId: "project-1",
          scenario: { task: "Task" },
          run: {
            _id: pair.runId,
            attemptNumber: 1,
            status: "done",
            handlerStatus: {
              "pp-taxonomy": {
                status: "done",
                version: 1,
                updatedAt: new Date(),
              },
            },
            taxonomyEvaluation: {
              url: `https://blob/${pair.runId}.json.gz`,
              schemaVersion: "scope/taxonomy-run-result/v1",
              contentSha256: createHash("sha256").update(body).digest("hex"),
              sizeBytes: body.byteLength,
            },
          },
        };
      }),
    };
    const blobStorage = {
      downloadBuffer: vi.fn(async (url: string) => {
        const runId = url.match(/(run-\d+)/)?.[1];
        return gzipSync(bodies.get(runId!)!);
      }),
    };

    const readout = await buildTaxonomyReadout(
      {
        requestCollection,
        runsCollection: { findOne: vi.fn() },
        blobStorage,
      } as never,
      {
        projectId: "project-1",
        experimentId: "experiment-1",
        executionId: "execution-1",
        requests: pairs,
        taxonomy: {
          taxonomyRevisionId: "taxonomy-revision-1",
          ref: "ax-taxonomy@r1",
          contentSha256: "a".repeat(64),
        },
      },
    );

    expect(readout.runs).toHaveLength(3);
    expect(
      readout.runs.map((run) => [run.requestId, run.runId, run.state]),
    ).toEqual([
      ["request-1", "run-1", "completed"],
      ["request-2", "run-2", "completed"],
      ["request-3", "run-3", "completed"],
    ]);
  });
});
