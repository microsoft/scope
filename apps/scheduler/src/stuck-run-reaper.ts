// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import type { HeartbeatStore, RequestDocument } from "shared";
import { durationSetFields } from "shared";
import { trackMetric, trackEvent } from "telemetry";

/**
 * StuckRunReaper — authoritative backstop that fails runs permanently stuck
 * in `processing` after their worker died without writing a terminal state.
 *
 * Recovery of a lost `processing` run normally relies on Azure Storage Queue
 * at-least-once redelivery (the duplicate-message path in the queue-processor).
 * That trigger can be lost — e.g. a duplicate was dropped historically, or a
 * message expired (queue TTL) — leaving the run `processing` with no message
 * in existence. The `RequestScheduler` only dispatches `pending` runs, so such
 * a run is stuck forever. This reaper sweeps Mongo directly and is the only
 * recovery path that does not depend on a queue message surviving.
 *
 * Safety model (mirrors the redelivery handler in queue-processor.ts, but is
 * deliberately MORE conservative because it acts on a direct DB scan rather
 * than an at-least-once queue redelivery):
 *
 *   - Confirms Redis is reachable (`heartbeatStore.ping()`) before treating a
 *     missing heartbeat as a dead worker — a Redis blip must never mass-fail
 *     healthy runs. If the post-`mget` stale set is "everything" while Redis
 *     returned no heartbeats at all, a second ping re-confirms reachability
 *     (closing the ping→die→mget window).
 *   - Only considers runs whose `startedAt` is older than the staleness
 *     threshold (applied in-memory so the Mongo query stays on the indexed
 *     `run.status` equality and needs no `run.startedAt` range index on
 *     CosmosDB).
 *   - Two-strikes: a run must look stale in two *consecutive* sweeps before it
 *     is reaped. A transient Redis read blip (which makes the whole fleet look
 *     stale for one sweep) is absorbed because nothing was stale in the prior
 *     sweep; only genuinely-dead runs persist across both.
 *   - Confirmation re-read: immediately before failing a run, its heartbeat is
 *     re-read with a single-key GET. A fresh beat here aborts the reap
 *     regardless of why the batch read missed it (issue #1064).
 *   - Per-sweep circuit-breaker: if more runs would be reaped than
 *     `maxPerSweep`, the sweep is skipped and logged loudly — a correlated
 *     spike is almost certainly systemic (CosmosDB throttling, network) rather
 *     than N genuine worker deaths.
 *   - Atomic claim gated on the current `run.worker.instanceId`, so a peer
 *     takeover / retry between read and write makes the claim no-op.
 *   - Does NOT enqueue post-processing itself; it leaves `postProcessorStatus`
 *     unset so the existing PostProcessorDispatcher claims and enqueues it
 *     (avoids a set-status-then-send rollback hazard — the reaper has no queue
 *     client).
 *
 * A false positive (failing a still-alive, still-owning worker whose heartbeat
 * gapped past the threshold for two sweeps) is safe: the worker's terminal
 * writes are gated on `run.status: "processing"`, so once the reaper sets
 * `done` they no-op. The cost is a wasted in-flight run, never state corruption.
 */
export interface StuckRunReaperOptions {
  /** How often to sweep, in ms. Default 60000. */
  pollIntervalMs?: number;
  /**
   * Heartbeat staleness threshold in ms. Should match the redelivery handler's
   * `SCOPE_RUN_HEARTBEAT_STALE_MS` for consistent behavior. Default 120000.
   */
  staleThresholdMs?: number;
  /**
   * Maximum runs to fail in a single sweep. If more than this would be reaped,
   * the sweep is skipped and logged loudly (treated as systemic). Default 30.
   */
  maxPerSweep?: number;
  /**
   * Maximum candidate documents pulled from Mongo per sweep. Bounds the Redis
   * `mget` and Mongo scan. Candidates are all in-flight `processing` runs, so
   * this is intentionally generous. Default 500.
   */
  scanLimit?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_STALE_THRESHOLD_MS = 120_000;
const DEFAULT_MAX_PER_SWEEP = 30;
const DEFAULT_SCAN_LIMIT = 500;

const posIntOr = (v: number | undefined, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;

type Candidate = {
  _id: string;
  runId: string;
  startedAt?: Date;
  ownerInstanceId?: string;
  workerDesc: string;
};

export class StuckRunReaper {
  private interval: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private closing = false;
  private activeSweep: Promise<void> | null = null;
  /** Run ids that looked stale in the previous sweep (two-strikes gate). */
  private previouslyStale = new Set<string>();

  private readonly pollIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly maxPerSweep: number;
  private readonly scanLimit: number;

  constructor(
    private readonly collection: Collection<RequestDocument>,
    private readonly heartbeatStore: HeartbeatStore,
    options: StuckRunReaperOptions = {},
  ) {
    // Defensive: never let a bad option (e.g. NaN) disable a safety control.
    this.pollIntervalMs = posIntOr(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.staleThresholdMs = posIntOr(options.staleThresholdMs, DEFAULT_STALE_THRESHOLD_MS);
    this.maxPerSweep = posIntOr(options.maxPerSweep, DEFAULT_MAX_PER_SWEEP);
    this.scanLimit = posIntOr(options.scanLimit, DEFAULT_SCAN_LIMIT);
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.activeSweep = this.sweep();
      void this.activeSweep;
    }, this.pollIntervalMs);
    this.activeSweep = this.sweep();
    void this.activeSweep;
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Await the in-flight sweep so we don't close Redis/Mongo from under it.
    if (this.activeSweep) {
      await Promise.race([
        this.activeSweep.catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    }
  }

  /** Exposed for tests. Runs one sweep. */
  async sweep(): Promise<void> {
    if (this.sweeping || this.closing) return;
    this.sweeping = true;
    const sweepStart = Date.now();
    let reaped = 0;
    try {
      // Redis-outage guard: if the heartbeat store is unreachable, a missing
      // heartbeat is meaningless (mget would return empty). Skip the sweep
      // rather than risk mass-failing healthy runs during a blip.
      if (!(await this.heartbeatStore.ping())) {
        console.warn(
          "[StuckRunReaper] Heartbeat store (Redis) unreachable — skipping sweep to avoid false positives",
        );
        return;
      }

      const candidates = await this.findCandidates();
      if (candidates.length === 0) {
        this.previouslyStale.clear();
        return;
      }

      const heartbeats = await this.heartbeatStore.mget(candidates.map((c) => c.runId));

      // Closing the ping→die→mget window: if Redis returned ZERO heartbeats for
      // a non-empty candidate set, that is the signature of a read failure
      // (real fleets almost always have at least one live beat). Re-confirm
      // reachability before trusting "all stale".
      if (heartbeats.size === 0 && !(await this.heartbeatStore.ping())) {
        console.warn(
          "[StuckRunReaper] Heartbeat store returned no beats and re-ping failed — skipping sweep",
        );
        return;
      }

      // Zero readable beats for a non-empty candidate set points at a systemic
      // heartbeat-read/Redis-misconfig problem, not N simultaneous worker deaths
      // (genuine deaths still expose present-but-stale beats inside the TTL).
      // Surface it loudly; the per-candidate confirmation read in reapOne() is
      // the actual false-positive guard (issue #1064).
      if (heartbeats.size === 0 && candidates.length > 0) {
        console.warn(
          `[StuckRunReaper] Read 0 live heartbeats for ${candidates.length} processing candidate(s) ` +
            `while Redis is reachable — likely a heartbeat read failure or Redis misconfiguration, ` +
            `not worker deaths. Each candidate is re-verified with a direct read before any reap. ` +
            `Verify the scheduler's REDIS_HOST/PORT/PASSWORD/TLS match the workers and API.`,
        );
      }

      const now = Date.now();
      let missingCount = 0;
      let staleCount = 0;
      const currentStale = candidates.filter((c) => {
        const hb = heartbeats.get(c.runId);
        if (!hb) {
          missingCount++;
          return true; // missing & startedAt already old (filtered in findCandidates)
        }
        if (now - hb.getTime() > this.staleThresholdMs) {
          staleCount++;
          return true;
        }
        return false;
      });
      if (currentStale.length > 0) {
        console.log(
          `[StuckRunReaper] Sweep: ${candidates.length} candidate(s), ${heartbeats.size} live beat(s), ` +
            `${staleCount} stale, ${missingCount} missing; ${this.previouslyStale.size} stale in prior sweep.`,
        );
      }
      const currentStaleIds = new Set(currentStale.map((c) => c.runId));

      // Two-strikes: only reap runs that were ALSO stale in the previous sweep.
      const toReap = currentStale.filter((c) => this.previouslyStale.has(c.runId));
      // Carry the current stale set forward for the next sweep's intersection.
      this.previouslyStale = currentStaleIds;

      if (toReap.length === 0) return;

      // Circuit-breaker: a large correlated spike is almost certainly systemic
      // (throttling / network), not N independent worker deaths. Refuse to
      // mass-fail and surface loudly for alerting.
      if (toReap.length > this.maxPerSweep) {
        console.error(
          `[StuckRunReaper] ${toReap.length} runs stale across two sweeps (> maxPerSweep=${this.maxPerSweep}) — likely systemic (Redis/CosmosDB/network). SKIPPING and NOT failing any runs. Investigate worker/Redis health; raise SCOPE_REAPER_MAX_PER_SWEEP only if these are genuine worker deaths.`,
        );
        return;
      }

      for (const c of toReap) {
        if (this.closing) break;
        const wasReaped = await this.reapOne(c, now);
        if (wasReaped) reaped++;
      }
    } catch (err) {
      console.error("[StuckRunReaper] Error during sweep:", err);
    } finally {
      this.sweeping = false;
      trackMetric({ name: "scheduler.reaper_sweep_ms", value: Date.now() - sweepStart, properties: { service: "scheduler" } });
      if (reaped > 0) {
        trackMetric({ name: "scheduler.reaper_runs_failed", value: reaped, properties: { service: "scheduler" } });
      }
    }
  }

  /**
   * Fetch in-flight `processing` runs. Filters only on the indexed `run.status`
   * equality (+ `deletedAt`) so the query needs no `run.startedAt` range index
   * on CosmosDB; the staleness cutoff is applied in-memory. This also naturally
   * covers a (malformed) run missing `startedAt`.
   */
  private async findCandidates(): Promise<Candidate[]> {
    const cutoff = Date.now() - this.staleThresholdMs;
    const docs = await this.collection
      .find(
        {
          "run.status": "processing",
          deletedAt: { $exists: false },
        } as any,
        {
          projection: {
            _id: 1,
            "run._id": 1,
            "run.startedAt": 1,
            "run.worker": 1,
          },
          limit: this.scanLimit,
        },
      )
      .toArray();

    const out: Candidate[] = [];
    for (const d of docs) {
      const run = (d as any).run;
      const runId = run?._id;
      if (!runId) continue;
      const startedAt = run.startedAt
        ? run.startedAt instanceof Date
          ? run.startedAt
          : new Date(run.startedAt)
        : undefined;
      // Only consider runs that have been processing longer than the threshold.
      // A processing run is always stamped with startedAt atomically at pickup;
      // a missing startedAt means a malformed/legacy doc — treat it as old.
      if (startedAt && startedAt.getTime() > cutoff) continue;
      const worker = run.worker;
      const workerDesc = worker
        ? `instance=${worker.instanceId ?? "unknown"}${worker.podName ? ` pod=${worker.podName}` : ""}`
        : "unknown worker";
      out.push({
        _id: d._id as any,
        runId,
        startedAt,
        ownerInstanceId: worker?.instanceId,
        workerDesc,
      });
    }
    return out;
  }

  private async reapOne(c: Candidate, now: number): Promise<boolean> {
    // Confirmation re-read (issue #1064): a single-key GET is always
    // shard-routable, so a fresh beat here means the worker is alive — abort the
    // reap regardless of why the batch read under-reported it.
    const confirmBeat = await this.heartbeatStore.get(c.runId);
    if (confirmBeat && now - confirmBeat.getTime() <= this.staleThresholdMs) {
      console.warn(
        `[StuckRunReaper] Aborting reap of request=${c._id} (runId=${c.runId}) — confirmation read found a ` +
          `fresh heartbeat (${Math.round((now - confirmBeat.getTime()) / 1000)}s ago). The batch heartbeat ` +
          `read under-reported liveness (likely a cross-slot MGET failure on clustered Redis); not reaping.`,
      );
      this.previouslyStale.delete(c.runId);
      return false;
    }

    const ageDesc = c.startedAt
      ? `${Math.round((now - c.startedAt.getTime()) / 1000)}s`
      : "unknown";
    const errorMsg =
      `Reaped by scheduler — run stuck in 'processing' with stale/missing heartbeat ` +
      `(${c.workerDesc}, started ${ageDesc} ago, threshold ${Math.round(this.staleThresholdMs / 1000)}s); ` +
      `no worker recovered it. Use the retry endpoint to start a new attempt.`;

    // Atomic claim: gate on the *current* run.worker.instanceId so a peer
    // takeover / retry between our read and write makes this a no-op.
    const reapFinishedAt = new Date();
    const claim = await this.collection.findOneAndUpdate(
      {
        _id: c._id,
        "run._id": c.runId,
        "run.status": "processing",
        ...(c.ownerInstanceId
          ? { "run.worker.instanceId": c.ownerInstanceId }
          : { "run.worker.instanceId": { $exists: false } }),
      } as any,
      {
        $set: {
          "run.status": "done",
          "run.outcome": "failed",
          "run.error": errorMsg,
          "run.finishedAt": reapFinishedAt,
          // Denormalize duration for server-side sort.
          ...durationSetFields(c.startedAt, reapFinishedAt),
          "run.updatedAt": new Date(),
          updatedAt: new Date(),
        },
        // Deliberately do NOT set run.postProcessorStatus — the
        // PostProcessorDispatcher will claim and enqueue post-processing.
      } as any,
      { returnDocument: "after" },
    );

    if (claim) {
      // Loud per-reap log: the reaper firing IS the worker-death signal, so
      // spikes must be alertable rather than recovering silently.
      console.warn(
        `[StuckRunReaper] Reaped stuck run: request=${c._id} runId=${c.runId} ${c.workerDesc} (started ${ageDesc} ago) — marked failed`,
      );
      // Run is terminal — drop the heartbeat key so the API stops surfacing it.
      await this.heartbeatStore.delete(c.runId);
      // Don't try to reap this id again next sweep.
      this.previouslyStale.delete(c.runId);
      return true;
    } else {
      console.log(
        `[StuckRunReaper] Skipped ${c._id} (runId=${c.runId}) — ownership/status changed concurrently`,
      );
      return false;
    }
  }
}
