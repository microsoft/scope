// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JudgeInfrastructureError, type JudgeClient } from "shared";
import { TaxonomyHandler } from "./taxonomy-handler.js";
import type { HandlerContext, PostProcessorMessage } from "../types.js";

interface CriterionMeta {
  id: string;
  subject?: "run" | "iteration";
}

function makeCtx(
  doc: unknown,
  metas: CriterionMeta[] = [],
): HandlerContext & { collection: { updateOne: ReturnType<typeof vi.fn> } } {
  const scopedDoc =
    typeof doc === "object" && doc !== null
      ? { projectId: "proj-test", ...doc }
      : doc;
  return {
    blobStorage: {} as any,
    collection: {
      findOne: vi.fn().mockResolvedValue(scopedDoc),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    } as any,
    criteriaCollection: {
      find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(metas) }),
    } as any,
    log: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const msg: PostProcessorMessage = { type: "observations", requestId: "req-1", runId: "run-1" };

describe("TaxonomyHandler", () => {
  let judge: { evaluate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    judge = { evaluate: vi.fn() };
  });

  it("has type 'observations'", () => {
    expect(new TaxonomyHandler(judge as unknown as JudgeClient).type).toBe("observations");
  });

  it("no-ops when no observations are selected", async () => {
    const ctx = makeCtx({ _id: "req-1", observations: [], run: { turns: [{ iteration: 1, snapshotUrl: "s://1" }] } });
    await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);
    expect(judge.evaluate).not.toHaveBeenCalled();
    expect(ctx.collection.updateOne).not.toHaveBeenCalled();
  });

  it("reads observations from the request top-level, not run.observations (#1156 regression)", async () => {
    // The API persists selected observation ids at the request top-level
    // (RequestDocument.observations). A doc that only carries the legacy
    // run.observations must be treated as "none selected" → no-op, proving the
    // handler reads the canonical location the submit path actually writes.
    const ctx = makeCtx({
      _id: "req-1",
      run: { observations: ["dep_removed"], turns: [{ iteration: 1, snapshotUrl: "s://1", atifUrl: "a://1" }] },
    });
    await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);
    expect(judge.evaluate).not.toHaveBeenCalled();
    expect(ctx.collection.updateOne).not.toHaveBeenCalled();
  });

  describe("subject:iteration", () => {
    it("writes judge criteriaResults to each turn's observationResults and sends atifUrl", async () => {
      judge.evaluate.mockResolvedValue({
        passed: true,
        feedback: "ok",
        criteriaResults: [{ criterionId: "uses_ts", passed: true, feedback: "tsconfig present", evaluated: true }],
      });
      const ctx = makeCtx(
        {
          _id: "req-1",
          observations: ["uses_ts"],
          run: { turns: [{ iteration: 1, snapshotUrl: "s://1", atifUrl: "a://1" }] },
        },
        [{ id: "uses_ts", subject: "iteration" }],
      );

      await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);

      expect(judge.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ snapshotUrl: "s://1", criteria: ["uses_ts"], atifUrl: "a://1" }),
      );
      const call = judge.evaluate.mock.calls[0][0];
      expect(call.gate).toBeUndefined();
      expect(call.toolCallsUrl).toBeUndefined();
      expect(call.atifUrls).toBeUndefined();
      expect(ctx.collection.updateOne).toHaveBeenCalledWith(
        { _id: "req-1", "run.turns.iteration": 1 },
        { $set: { "run.turns.$.observationResults": [{ criterionId: "uses_ts", passed: true, feedback: "tsconfig present", evaluated: true }] } },
      );
    });

    it("skips iterations without a snapshotUrl", async () => {
      judge.evaluate.mockResolvedValue({ passed: true, feedback: "", criteriaResults: [] });
      const ctx = makeCtx(
        { _id: "req-1", observations: ["c1"], run: { turns: [{ iteration: 1 }] } },
        [{ id: "c1", subject: "iteration" }],
      );
      await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);
      expect(judge.evaluate).not.toHaveBeenCalled();
    });

    it("throws on judge infrastructure error so the handler is marked failed", async () => {
      judge.evaluate.mockRejectedValue(new JudgeInfrastructureError("down", { httpStatus: 503 }));
      const ctx = makeCtx(
        { _id: "req-1", observations: ["c1"], run: { turns: [{ iteration: 1, snapshotUrl: "s://1" }] } },
        [{ id: "c1", subject: "iteration" }],
      );
      await expect(new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx)).rejects.toThrow("down");
    });
  });

  describe("subject:run", () => {
    it("evaluates ONCE over the merged trajectory and writes run-level observationResults", async () => {
      judge.evaluate.mockResolvedValue({
        passed: true,
        feedback: "ok",
        criteriaResults: [
          { criterionId: "dep_added_then_removed", passed: true, feedback: "left-pad added then removed", evaluated: true },
        ],
      });
      const ctx = makeCtx(
        {
          _id: "req-1",
          observations: ["dep_added_then_removed"],
          run: {
            turns: [
              { iteration: 1, snapshotUrl: "s://1", atifUrl: "a://1" },
              { iteration: 2, snapshotUrl: "s://2", atifUrl: "a://2" },
            ],
          },
        },
        [{ id: "dep_added_then_removed", subject: "run" }],
      );

      await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);

      // One judge call, using the FINAL snapshot + EVERY iteration's atif merged.
      expect(judge.evaluate).toHaveBeenCalledTimes(1);
      expect(judge.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshotUrl: "s://2",
          criteria: ["dep_added_then_removed"],
          atifUrls: ["a://1", "a://2"],
        }),
      );
      const call = judge.evaluate.mock.calls[0][0];
      expect(call.atifUrl).toBeUndefined();
      // Written at the RUN level, not on any turn.
      expect(ctx.collection.updateOne).toHaveBeenCalledWith(
        { _id: "req-1" },
        { $set: { "run.observationResults": [{ criterionId: "dep_added_then_removed", passed: true, feedback: "left-pad added then removed", evaluated: true }] } },
      );
    });

    it("defaults a subject-less observation to run (whole-run evaluation)", async () => {
      judge.evaluate.mockResolvedValue({ passed: false, feedback: "no", criteriaResults: [] });
      const ctx = makeCtx(
        {
          _id: "req-1",
          observations: ["legacy_obs"],
          run: { turns: [{ iteration: 1, snapshotUrl: "s://1", atifUrl: "a://1" }] },
        },
        [{ id: "legacy_obs" }], // no subject → defaults to run
      );

      await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);

      expect(judge.evaluate).toHaveBeenCalledTimes(1);
      const call = judge.evaluate.mock.calls[0][0];
      expect(call.atifUrls).toEqual(["a://1"]);
      expect(ctx.collection.updateOne).toHaveBeenCalledWith(
        { _id: "req-1" },
        expect.objectContaining({ $set: expect.objectContaining({ "run.observationResults": [] }) }),
      );
    });

    it("throws on judge infrastructure error during the run-subject evaluation", async () => {
      judge.evaluate.mockRejectedValue(new JudgeInfrastructureError("down", { httpStatus: 503 }));
      const ctx = makeCtx(
        { _id: "req-1", observations: ["r1"], run: { turns: [{ iteration: 1, snapshotUrl: "s://1", atifUrl: "a://1" }] } },
        [{ id: "r1", subject: "run" }],
      );
      await expect(new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx)).rejects.toThrow("down");
    });
  });

  describe("mixed subjects", () => {
    it("routes iteration and run observations to their respective evaluations", async () => {
      judge.evaluate.mockResolvedValue({ passed: true, feedback: "ok", criteriaResults: [] });
      const ctx = makeCtx(
        {
          _id: "req-1",
          observations: ["iter_obs", "run_obs"],
          run: {
            turns: [
              { iteration: 1, snapshotUrl: "s://1", atifUrl: "a://1" },
              { iteration: 2, snapshotUrl: "s://2", atifUrl: "a://2" },
            ],
          },
        },
        [
          { id: "iter_obs", subject: "iteration" },
          { id: "run_obs", subject: "run" },
        ],
      );

      await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);

      // 2 iteration calls (one per turn) + 1 run call = 3 total.
      expect(judge.evaluate).toHaveBeenCalledTimes(3);
      const iterationCalls = judge.evaluate.mock.calls.filter((c) => c[0].criteria.includes("iter_obs"));
      const runCalls = judge.evaluate.mock.calls.filter((c) => c[0].criteria.includes("run_obs"));
      expect(iterationCalls).toHaveLength(2);
      expect(runCalls).toHaveLength(1);
      // The iteration eval only carries the iteration-subject criterion.
      expect(iterationCalls[0][0].criteria).toEqual(["iter_obs"]);
      // The run eval only carries the run-subject criterion, merged trajectory.
      expect(runCalls[0][0].criteria).toEqual(["run_obs"]);
      expect(runCalls[0][0].atifUrls).toEqual(["a://1", "a://2"]);
    });
  });
});
