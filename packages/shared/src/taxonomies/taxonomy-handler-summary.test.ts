// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { RunState } from "../types/types.js";
import { taxonomyHandlerSummary } from "./taxonomy-handler-summary.js";

function run(
  status?: "queued" | "processing" | "done" | "failed",
  resultAvailable = false,
): RunState {
  return {
    _id: "run-1",
    attemptNumber: 1,
    status: "done",
    ...(status
      ? {
          handlerStatus: {
            "pp-taxonomy": {
              status,
              updatedAt: new Date("2026-10-30T00:00:00.000Z"),
              ...(status === "failed" ? { error: "evaluation failed" } : {}),
            },
          },
        }
      : {}),
    ...(resultAvailable
      ? {
          taxonomyEvaluation: {
            url: "https://blob/result.json.gz",
            schemaVersion: "scope/taxonomy-run-result/v1",
            contentSha256: "a".repeat(64),
            sizeBytes: 123,
          },
        }
      : {}),
  };
}

describe("taxonomyHandlerSummary", () => {
  it("returns undefined without a persisted handler entry", () => {
    expect(taxonomyHandlerSummary(run())).toBeUndefined();
  });

  it.each(["queued", "processing", "failed"] as const)(
    "preserves %s without inferring progress",
    (status) => {
      expect(taxonomyHandlerSummary(run(status))).toMatchObject({
        status,
        resultAvailable: false,
      });
    },
  );

  it("distinguishes done with and without the exact result reference", () => {
    expect(taxonomyHandlerSummary(run("done"))).toMatchObject({
      status: "done",
      resultAvailable: false,
    });
    expect(taxonomyHandlerSummary(run("done", true))).toMatchObject({
      status: "done",
      resultAvailable: true,
    });
  });
});
