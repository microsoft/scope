// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { HandlerServiceDocument, RunState, SubmissionRunState } from "../types/types.js";
import {
  OBSERVATIONS_HANDLER_ID,
  READOUT_HANDLER_ID,
  computeSubmissionVectorFingerprint,
  deriveSubmissionReadiness,
  evaluateNamedHandlerState,
  isHandlerDagDrained,
  projectSubmissionDependency,
} from "./submission-state.js";

const handlers: HandlerServiceDocument[] = [
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
    _id: OBSERVATIONS_HANDLER_ID,
    type: "post-process-handler",
    version: 1,
    queue: "post-processor",
    selector: "observations",
    autoBackfill: true,
    dependsOn: ["pp-atif"],
  },
];

function run(handlerStatus: RunState["handlerStatus"]): RunState {
  return {
    _id: "run-1",
    attemptNumber: 1,
    status: "done",
    outcome: "failed",
    handlerStatus,
    observationResults: [
      { criterionId: "observation-1", passed: false, feedback: "evidence", evaluated: true },
    ],
  };
}

describe("submission state helpers", () => {
  it("fingerprints vectors deterministically independent of request order", () => {
    expect(
      computeSubmissionVectorFingerprint([
        { requestId: "b", runId: "2" },
        { requestId: "a", runId: "1" },
      ]),
    ).toBe(
      computeSubmissionVectorFingerprint([
        { requestId: "a", runId: "1" },
        { requestId: "b", runId: "2" },
      ]),
    );
  });

  it("treats completed observations as ready even for failed coding outcomes and passed:false evidence", () => {
    const result = projectSubmissionDependency({
      requestId: "request-1",
      expectedRunId: "run-1",
      run: run({
        [OBSERVATIONS_HANDLER_ID]: { status: "done", version: 1 },
        unrelated: { status: "failed", error: "ignored" },
      }),
      handlers,
    });

    expect(result).toEqual({
      projection: {
        requestId: "request-1",
        runId: "run-1",
        handlerId: OBSERVATIONS_HANDLER_ID,
        state: "ready",
        version: 1,
      },
      drifted: false,
    });
  });

  it("blocks when observations fail or are blocked by a failed dependency", () => {
    expect(
      evaluateNamedHandlerState(
        OBSERVATIONS_HANDLER_ID,
        handlers,
        { [OBSERVATIONS_HANDLER_ID]: { status: "failed" } },
      ),
    ).toBe("failed");
    expect(
      evaluateNamedHandlerState(
        OBSERVATIONS_HANDLER_ID,
        handlers,
        { "pp-atif": { status: "failed" } },
      ),
    ).toBe("blocked");
  });

  it("reuses named-handler DAG semantics for existing report triggering", () => {
    expect(
      isHandlerDagDrained(handlers, {
        "pp-atif": { status: "failed" },
      }),
    ).toBe(true);
    expect(
      isHandlerDagDrained(handlers, {
        "pp-atif": { status: "processing" },
      }),
    ).toBe(false);
  });

  it("detects exact run drift", () => {
    const result = projectSubmissionDependency({
      requestId: "request-1",
      expectedRunId: "old-run",
      run: run({ [OBSERVATIONS_HANDLER_ID]: { status: "done" } }),
      handlers,
    });
    expect(result.drifted).toBe(true);
    expect(result.blocking?.reason).toBe("run-changed");
  });

  it("derives submission readiness from dependencies and readout progress", () => {
    const base: SubmissionRunState = {
      _id: "submission-run-1",
      attemptNumber: 1,
      vectorFingerprint: "fingerprint",
      requests: [{ requestId: "request-1", runId: "run-1" }],
      createdAt: new Date(),
      dependencyProjection: [{
        requestId: "request-1",
        runId: "run-1",
        handlerId: OBSERVATIONS_HANDLER_ID,
        state: "ready",
      }],
      blocking: [],
    };

    expect(deriveSubmissionReadiness(base)).toBe("ready");
    expect(deriveSubmissionReadiness({
      ...base,
      handlerStatus: { [READOUT_HANDLER_ID]: { status: "processing" } },
    })).toBe("processing");
    expect(deriveSubmissionReadiness({
      ...base,
      handlerStatus: { [READOUT_HANDLER_ID]: { status: "done" } },
    })).toBe("done");
  });
});
