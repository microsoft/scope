// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { JudgeClient, isRetryableJudgeError } from "shared";
import type { ConversationTurn, CriterionResult, CriterionSubject } from "shared";
import type { PostProcessHandler, PostProcessorMessage, HandlerContext } from "../types.js";
import { POST_PROCESSOR_VERSION } from "../version.js";

/** Minimal shape of the request document fields this handler reads/writes. */
interface RequestDoc {
  projectId: string;
  /** Observation-criteria ids selected at submit. Stored at the request
   *  top-level by the API (see RequestDocument.observations / issue #1156),
   *  NOT under `run` — the run subdocument only carries per-turn results. */
  observations?: string[];
  run?: {
    _id?: string;
    turns?: ConversationTurn[];
  };
}

/** Minimal projection of a criterion needed to route by evaluation granularity. */
interface CriterionMeta {
  id: string;
  subject?: CriterionSubject;
}

/**
 * Taxonomy Handler (pp-observations): records boolean observations.
 *
 * Each selected observation criterion is routed by its `subject` (#1156):
 *
 * - **`subject:"iteration"`** — evaluated on each iteration in isolation against
 *   that turn's snapshot + ATIF; written to `turn.observationResults` (mirrors
 *   gate `criteriaResults`).
 * - **`subject:"run"`** (the observation default) — evaluated ONCE against the
 *   whole run: the final iteration's snapshot + the MERGED trajectory of every
 *   iteration's ATIF (`atifUrls`) + the full conversation history; written to the
 *   run-level `run.observationResults`. This is what makes cross-iteration
 *   behavior (e.g. a dependency added in one turn and removed in another) visible.
 *
 * Reuses the judge service; never gates, never steers the agent. Empty/absent
 * `observations` → no-op. pp-observations is dispatched exactly once per run (the
 * scheduler never sets `message.iteration`), so the run-subject branch runs once
 * with no idempotency guard.
 */
export class TaxonomyHandler implements PostProcessHandler {
  readonly type = "observations";
  readonly version = POST_PROCESSOR_VERSION;
  readonly autoBackfill = true;
  private readonly judge: JudgeClient;

  constructor(judge?: JudgeClient, judgeUrl = process.env.JUDGE_URL || process.env.JUDGE_SERVICE_URL || "http://localhost:3002") {
    this.judge = judge ?? new JudgeClient(judgeUrl);
  }

  async process(message: PostProcessorMessage, ctx: HandlerContext): Promise<void> {
    const { requestId, iteration } = message;

    const doc = (await ctx.collection.findOne({ _id: requestId } as any)) as RequestDoc | null;
    const observations = doc?.observations ?? [];
    const turns = doc?.run?.turns ?? [];
    const projectId = doc?.projectId;

    if (observations.length === 0) {
      await ctx.log("info", "No observations selected, skipping taxonomy evaluation");
      return;
    }
    if (turns.length === 0) {
      await ctx.log("info", "No turns found, skipping taxonomy evaluation");
      return;
    }
    if (!projectId) {
      throw new Error(`Request '${requestId}' is missing projectId`);
    }

    // Resolve each selected observation's evaluation granularity. A missing/unknown
    // subject defaults to "run" (the observation default), so legacy criteria authored
    // before the `subject` field get whole-run evaluation.
    const metas = (await ctx.criteriaCollection
      .find(
        { projectId, id: { $in: observations } },
        { projection: { id: 1, subject: 1 } } as any,
      )
      .toArray()) as unknown as CriterionMeta[];
    const subjectById = new Map(metas.map((m) => [m.id, m.subject]));
    const iterationObs = observations.filter((id) => subjectById.get(id) === "iteration");
    const runObs = observations.filter((id) => subjectById.get(id) !== "iteration");

    await this.evaluateIterationObservations(iterationObs, turns, iteration, requestId, projectId, ctx);
    await this.evaluateRunObservations(runObs, turns, iteration, requestId, projectId, ctx);
  }

  /** Per-iteration observations → `turn.observationResults` (one judge call per turn). */
  private async evaluateIterationObservations(
    iterationObs: string[],
    turns: ConversationTurn[],
    iteration: number | undefined,
    requestId: string,
    projectId: string,
    ctx: HandlerContext,
  ): Promise<void> {
    if (iterationObs.length === 0) return;

    const turnsToProcess = iteration ? turns.filter((t) => t.iteration === iteration) : turns;
    let processedCount = 0;

    for (const turn of turnsToProcess) {
      if (!turn.snapshotUrl) {
        await ctx.log("info", `Iteration ${turn.iteration}: no snapshot, skipping`);
        continue;
      }

      try {
        const result = await this.judge.evaluate({
          snapshotUrl: turn.snapshotUrl,
          criteria: iterationObs,
          conversationHistory: turns,
          ...(turn.atifUrl ? { atifUrl: turn.atifUrl } : {}),
          requestId,
          projectId,
        });

        const observationResults: CriterionResult[] = result.criteriaResults ?? [];

        await ctx.collection.updateOne(
          { _id: requestId, "run.turns.iteration": turn.iteration } as any,
          { $set: { "run.turns.$.observationResults": observationResults } } as any,
        );

        processedCount++;
        await ctx.log("info", `Iteration ${turn.iteration}: ${observationResults.length} observations recorded`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isRetryableJudgeError(err)) {
          await ctx.log("error", `Iteration ${turn.iteration}: judge infrastructure error, failing handler: ${errMsg}`);
          throw err;
        }
        await ctx.log("warn", `Iteration ${turn.iteration}: observation evaluation failed: ${errMsg}`);
      }
    }

    await ctx.log(
      "info",
      `Iteration-subject evaluation complete: ${processedCount}/${turnsToProcess.length} iterations processed`,
    );
  }

  /**
   * Whole-run observations → `run.observationResults` (one judge call over the
   * merged trajectory). Skipped when a single-iteration dispatch is requested
   * (forward-compat: a whole-run eval needs every turn). Today `message.iteration`
   * is never set, so this runs once per run.
   */
  private async evaluateRunObservations(
    runObs: string[],
    turns: ConversationTurn[],
    iteration: number | undefined,
    requestId: string,
    projectId: string,
    ctx: HandlerContext,
  ): Promise<void> {
    if (runObs.length === 0) return;
    if (iteration) {
      await ctx.log(
        "info",
        `Skipping ${runObs.length} run-subject observation(s): single-iteration dispatch cannot evaluate the whole run`,
      );
      return;
    }

    const turnsWithSnapshot = turns.filter((t) => t.snapshotUrl);
    const finalTurn = turnsWithSnapshot[turnsWithSnapshot.length - 1];
    if (!finalTurn?.snapshotUrl) {
      await ctx.log("info", "No turn with a snapshot, skipping run-subject observations");
      return;
    }

    // Merge every iteration's ATIF into one whole-run trajectory.
    const atifUrls = turns
      .map((t) => t.atifUrl)
      .filter((u): u is string => typeof u === "string" && u.length > 0);

    try {
      const result = await this.judge.evaluate({
        snapshotUrl: finalTurn.snapshotUrl,
        criteria: runObs,
        conversationHistory: turns,
        ...(atifUrls.length > 0 ? { atifUrls } : {}),
        requestId,
        projectId,
      });

      const runObservationResults: CriterionResult[] = result.criteriaResults ?? [];

      await ctx.collection.updateOne(
        { _id: requestId } as any,
        { $set: { "run.observationResults": runObservationResults } } as any,
      );

      await ctx.log(
        "info",
        `Run-subject evaluation complete: ${runObservationResults.length} whole-run observation(s) recorded over ${atifUrls.length} merged trajectory(ies)`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isRetryableJudgeError(err)) {
        await ctx.log("error", `Run-subject: judge infrastructure error, failing handler: ${errMsg}`);
        throw err;
      }
      await ctx.log("warn", `Run-subject observation evaluation failed: ${errMsg}`);
    }
  }
}
