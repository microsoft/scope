// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection, Db } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import type { RequestDocument, HandlerServiceDocument, HandlerRunStatus } from "shared";
import { DependencyGraph, withRetry } from "shared";
import type { RetryOptions } from "shared";
import type { NotifyHandler } from "./notify-routes.js";

/**
 * HandlerDispatcher — DAG-aware post-processing orchestrator.
 *
 * Reads handler topology from the `services` collection (type: "post-process-handler"),
 * builds a DependencyGraph, and dispatches handlers whose dependencies are satisfied.
 *
 * Two trigger paths:
 * 1. `onRunTerminal` — a coder worker signals run completion. Dispatches root handlers.
 * 2. `onHandlerComplete` — a handler signals completion. Dispatches downstream handlers.
 *
 * Also runs a poll safety net to catch missed notifications.
 */
export class HandlerDispatcher implements NotifyHandler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;
  private queueClients = new Map<string, QueueClient>();

  /** Cached handler topology. The `services` collection changes only on deploys
   *  (via registerHandler), yet loadHandlers() sits on the notify/poll hot path
   *  (2–3 reads per notify, plus every poll cycle). A TTL cache eliminates nearly
   *  all of those reads — significant on CosmosDB where each query costs RUs.
   *
   *  Coherence comes primarily from `registerHandler` invalidating the cache the
   *  moment topology changes, not from expiry: the scheduler is a singleton
   *  (`replicas: 1`, `Recreate`) and the sole writer of the `services` collection,
   *  so a same-process registration is reflected immediately regardless of TTL.
   *  The TTL is therefore a coarse defensive backstop (out-of-band writes, or a
   *  future scale-out to >1 replica) and is intentionally set well above the poll
   *  interval so the poll loop doesn't force a fresh read every cycle. */
  private handlerCache: { docs: HandlerServiceDocument[]; expiresAt: number } | null = null;

  /** Retry policy for the report-trigger POST. The 30s poll net is the durable
   *  backstop, so in-call retries are modest. Overridable in tests. */
  private reportRetryOptions: RetryOptions = {
    maxRetries: 4,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
    isRetryable: () => true,
  };

  constructor(
    private readonly collection: Collection<RequestDocument>,
    private readonly db: Db,
    private readonly createQueueClient: (queueName: string) => QueueClient,
    private readonly pollIntervalMs: number = 30_000,
    private readonly batchSize: number = 30,
    private readonly apiUrl: string = process.env.API_URL || "http://api:80",
    private readonly handlerCacheTtlMs: number = 300_000,
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.pollDispatch(), this.pollIntervalMs);
    void this.pollDispatch();
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const deadline = Date.now() + 5_000;
    while (this.dispatching && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ── NotifyHandler implementation ────────────────────────────────────

  async onRunTerminal(requestId: string, runId: string): Promise<void> {
    console.log(`[HandlerDispatcher] Notify: run-terminal ${requestId} (run=${runId})`);
    const handlers = await this.loadHandlers();

    if (handlers.length > 0) {
      const graph = this.buildGraph(handlers);
      const roots = handlers.filter((h) => !h.dependsOn || h.dependsOn.length === 0);

      for (const handler of roots) {
        await this.dispatchIfEligible(requestId, runId, handler, graph, handlers);
      }
    }

    // A run with no handlers (or an already-drained DAG) triggers reports now.
    await this.maybeTriggerReports(requestId, runId);
  }

  async onHandlerComplete(
    requestId: string,
    runId: string,
    handlerId: string,
    status: "done" | "failed",
  ): Promise<void> {
    console.log(
      `[HandlerDispatcher] Notify: handler-complete ${handlerId} for ${requestId} (status=${status})`,
    );

    // Only apply terminal status from an active in-flight execution.
    // This avoids stale/duplicate notifies regressing a newly re-dispatched
    // handler back to "done" or "failed".
    const updateResult = await this.collection.updateOne(
      { _id: requestId, [`run.handlerStatus.${handlerId}.status`]: "processing" } as any,
      {
        $set: {
          [`run.handlerStatus.${handlerId}.status`]: status,
          [`run.handlerStatus.${handlerId}.updatedAt`]: new Date(),
        },
      } as any,
    );

    if (updateResult.matchedCount === 0) {
      console.log(
        `[HandlerDispatcher] Ignored stale/duplicate completion for ${handlerId} on ${requestId}`,
      );
      return;
    }

    if (status === "failed") {
      // Don't dispatch downstream on failure, but the failure may have drained
      // the DAG (descendants are now permanently blocked) — check for reports.
      await this.maybeTriggerReports(requestId, runId);
      return;
    }

    // Find and dispatch eligible downstream handlers
    const handlers = await this.loadHandlers();
    if (handlers.length === 0) return;

    const graph = this.buildGraph(handlers);
    const descendants = graph.getDescendants(handlerId);

    // Only check immediate children (not all descendants)
    const children = handlers.filter(
      (h) => h.dependsOn?.includes(handlerId) && descendants.has(h._id),
    );

    for (const child of children) {
      await this.dispatchIfEligible(requestId, runId, child, graph, handlers);
    }

    // Completing this handler may have drained the DAG (e.g. it was the leaf).
    await this.maybeTriggerReports(requestId, runId);
  }

  async registerHandler(doc: HandlerServiceDocument): Promise<void> {
    // Validate the resulting topology has no cycles before persisting. Read
    // fresh (bypass the cache) so validation reflects any concurrent registrations.
    const existing = await this.loadHandlers(true);
    const merged = [
      ...existing.filter((h) => h._id !== doc._id),
      doc,
    ];
    // Throws on cycle — rejects invalid registrations.
    this.buildGraph(merged);

    const { _id, ...fields } = doc;
    await this.db.collection("services").updateOne(
      { _id } as any,
      {
        $set: {
          ...fields,
          dependsOn: [...fields.dependsOn],
          updatedAt: new Date(),
        },
      } as any,
      { upsert: true },
    );
    // Topology changed — drop the cache so the next read picks up the new handler.
    this.invalidateHandlerCache();
    console.log(
      `[HandlerDispatcher] Registered handler ${_id} (version=${doc.version}, queue=${doc.queue}, dependsOn=[${doc.dependsOn.join(", ")}])`,
    );
  }

  // ── Report trigger on DAG drain ─────────────────────────────────────

  /**
   * A handler is "terminal" for a run when it can produce no further work:
   * it has succeeded (`done`), failed (`failed`), or is permanently blocked
   * because one of its transitive dependencies failed (so it can never run).
   */
  private isHandlerTerminal(
    handlerId: string,
    graph: DependencyGraph,
    handlerStatus: Record<string, HandlerRunStatus> | undefined,
  ): boolean {
    const status = handlerStatus?.[handlerId]?.status;
    if (status === "done" || status === "failed") return true;

    // Not yet dispatched/processed — terminal only if blocked by a failed
    // ancestor (any transitive dependency that failed).
    if (status === undefined) {
      for (const ancestorId of graph.getAncestors(handlerId)) {
        if (handlerStatus?.[ancestorId]?.status === "failed") return true;
      }
    }

    // "queued" or "processing" — still active.
    return false;
  }

  /**
   * The DAG is drained for a run when every registered handler is terminal.
   * Vacuously true when there are no handlers.
   */
  private isDagDrained(
    handlers: HandlerServiceDocument[],
    graph: DependencyGraph,
    handlerStatus: Record<string, HandlerRunStatus> | undefined,
  ): boolean {
    return handlers.every((h) =>
      this.isHandlerTerminal(h._id, graph, handlerStatus),
    );
  }

  /**
   * If the run's handler DAG has drained and reports have not yet been
   * triggered, atomically claim the exactly-once guard and POST to the API's
   * report-trigger endpoint. Rolls the guard back on failure so the poll
   * safety net retries.
   *
   * All reads/writes are scoped to the specific attempt (`run._id === runId`)
   * so a stale notify or a concurrent retry can never trigger reports for, or
   * roll back the guard of, a different attempt.
   */
  private async maybeTriggerReports(requestId: string, runId: string): Promise<void> {
    const doc = await this.collection.findOne({ _id: requestId } as any);
    const run = doc?.run;
    if (!run || run._id !== runId || run.status !== "done") return;
    if ((run as any).reportsTriggeredAt) return;

    const handlers = await this.loadHandlers();
    const graph = this.buildGraph(handlers);
    const handlerStatus = (run as any).handlerStatus as
      | Record<string, HandlerRunStatus>
      | undefined;

    if (!this.isDagDrained(handlers, graph, handlerStatus)) return;

    // Atomically claim the trigger so concurrent notify/poll paths fire once.
    const claimed = await this.collection.findOneAndUpdate(
      {
        _id: requestId,
        "run._id": runId,
        "run.status": "done",
        "run.reportsTriggeredAt": { $exists: false },
      } as any,
      { $set: { "run.reportsTriggeredAt": new Date() } } as any,
      { returnDocument: "after" },
    );
    if (!claimed) return; // Another path already claimed it.

    try {
      await this.triggerReports(requestId);
      console.log(
        `[HandlerDispatcher] Triggered report generation for ${requestId} (DAG drained)`,
      );
    } catch (err) {
      // Roll back the guard so a later poll retries — scoped to this attempt so
      // a concurrent retry's valid guard is never cleared.
      await this.collection.updateOne(
        { _id: requestId, "run._id": runId } as any,
        { $unset: { "run.reportsTriggeredAt": "" } } as any,
      );
      console.error(
        `[HandlerDispatcher] Report trigger failed for ${requestId}, rolled back guard:`,
        err,
      );
    }
  }

  /** POSTs to the API's report-trigger endpoint with retry on transient errors. */
  private async triggerReports(requestId: string): Promise<void> {
    const url = `${this.apiUrl}/api/v1/reports/trigger`;
    await withRetry(async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`POST ${url} -> ${res.status} ${text}`.trim());
      }
    }, this.reportRetryOptions);
  }

  // ── Poll safety net ─────────────────────────────────────────────────

  private async pollDispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const handlers = await this.loadHandlers();

      if (handlers.length > 0) {
        const graph = this.buildGraph(handlers);

        for (const handler of handlers) {
          const filter = this.buildDispatchFilter(handler, handlers, graph);
          if (!filter) continue;

          const candidates = await this.collection
            .find(filter as any, {
              projection: { _id: 1, "run._id": 1 },
              sort: { updatedAt: -1 },
              limit: this.batchSize,
            })
            .toArray();

          for (const candidate of candidates) {
            const runId = (candidate as any).run?._id as string | undefined;
            if (!runId) continue;
            await this.dispatchIfEligible(candidate._id, runId, handler, graph, handlers);
          }
        }
      }

      // Safety net: trigger reports for any done run whose DAG has drained but
      // whose report trigger was missed (e.g. a dropped notify).
      await this.pollTriggerReports();
    } catch (err) {
      console.error("[HandlerDispatcher] Error during poll dispatch:", err);
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * Scans for `done` runs whose reports have not yet been triggered and runs
   * the drain check on each. Bounded by `batchSize` per poll.
   */
  private async pollTriggerReports(): Promise<void> {
    const candidates = await this.collection
      .find({
        "run.status": "done",
        "run.reportsTriggeredAt": { $exists: false },
        deletedAt: { $exists: false },
      } as any)
      .limit(this.batchSize)
      .toArray();

    for (const doc of candidates) {
      const runId = (doc as any).run?._id as string | undefined;
      if (!runId) continue;
      await this.maybeTriggerReports(doc._id, runId);
    }
  }

  // ── Dispatch logic ──────────────────────────────────────────────────

  private async dispatchIfEligible(
    requestId: string,
    runId: string,
    handler: HandlerServiceDocument,
    graph: DependencyGraph,
    allHandlers: HandlerServiceDocument[],
  ): Promise<void> {
    // Check if all dependencies are satisfied for this request
    const doc = await this.collection.findOne({ _id: requestId } as any);
    if (!doc?.run || doc.run.status !== "done") return;
    if (doc.run._id !== runId) return;

    const handlerStatus = (doc.run as any).handlerStatus as
      | Record<string, HandlerRunStatus>
      | undefined;

    // Check dependencies are all "done"
    if (handler.dependsOn && handler.dependsOn.length > 0) {
      for (const depId of handler.dependsOn) {
        const depStatus = handlerStatus?.[depId]?.status;
        if (depStatus !== "done") return; // Dependency not satisfied
      }
    }

    // Check whether this handler still needs work.
    const currentStatus = handlerStatus?.[handler._id]?.status;
    const currentVersion = handlerStatus?.[handler._id]?.version;
    const statusExclusions = handler.autoBackfill
      ? ["queued", "processing"]
      : ["queued", "processing", "done"];

    if (currentStatus && statusExclusions.includes(currentStatus)) {
      return;
    }

    if (handler.autoBackfill) {
      if (currentVersion !== undefined && currentVersion >= handler.version) {
        return;
      }
    } else if (currentVersion !== undefined) {
      return;
    }

    // Queue FIRST, then write the best-effort "queued" marker back to Mongo.
    // The queue message is the durable work signal; the DB status is only an
    // optimization / observability hint. If we crash after sendMessage() but
    // before this update, the worker entrypoint claim still makes the message
    // safe and prevents a permanent "queued" wedge.
    const enqueued = await this.enqueueToHandler(handler, requestId, runId);
    if (!enqueued) return;

    // This is NOT the authoritative processing claim. It only records that a
    // message was successfully placed on the queue and is expected to be picked
    // up soon. The worker performs the real claim when it atomically flips the
    // handler from eligible -> processing for this specific run attempt.
    const queueMarkFilter = this.buildDispatchFilter(handler, allHandlers, graph);
    const queueMarkResult = await this.collection.updateOne(
      {
        _id: requestId,
        "run._id": runId,
        ...(queueMarkFilter ?? {}),
      } as any,
      {
        $set: {
          [`run.handlerStatus.${handler._id}.status`]: "queued",
          [`run.handlerStatus.${handler._id}.updatedAt`]: new Date(),
        },
      } as any,
    );

    if ((queueMarkResult.matchedCount ?? 0) === 0) {
      console.log(
        `[HandlerDispatcher] ${handler._id} for ${requestId} advanced concurrently after enqueue; leaving queue message to worker idempotency guard`,
      );
      return;
    }

    console.log(`[HandlerDispatcher] Dispatched ${handler._id} for ${requestId}`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private buildDispatchFilter(
    handler: HandlerServiceDocument,
    allHandlers: HandlerServiceDocument[],
    _graph: DependencyGraph,
  ): Record<string, unknown> | null {
    const statusExclusions = handler.autoBackfill
      ? ["queued", "processing"]
      : ["queued", "processing", "done"];

    const filter: Record<string, unknown> = {
      "run.status": "done",
      deletedAt: { $exists: false },
      [`run.handlerStatus.${handler._id}.status`]: { $nin: statusExclusions },
    };

    // All dependencies must be "done"
    if (handler.dependsOn && handler.dependsOn.length > 0) {
      for (const depId of handler.dependsOn) {
        filter[`run.handlerStatus.${depId}.status`] = "done";
      }
    }

    // Backfill: version check
    if (handler.autoBackfill) {
      filter.$or = [
        { [`run.handlerStatus.${handler._id}.version`]: { $exists: false } },
        { [`run.handlerStatus.${handler._id}.version`]: { $lt: handler.version } },
      ];
    } else {
      // Only dispatch if never processed
      filter[`run.handlerStatus.${handler._id}.version`] = { $exists: false };
    }

    return filter;
  }

  private async enqueueToHandler(
    handler: HandlerServiceDocument,
    requestId: string,
    runId: string,
  ): Promise<boolean> {
    const queueClient = await this.getOrCreateQueueClient(handler.queue);
    const message = Buffer.from(
      JSON.stringify({
        type: handler.selector,
        requestId,
        runId,
      }),
    ).toString("base64");

    try {
      await queueClient.sendMessage(message);
      return true;
    } catch (err) {
      console.error(
        `[HandlerDispatcher] Queue send failed for ${handler._id}/${requestId}:`,
        err,
      );
      return false;
    }
  }

  private async getOrCreateQueueClient(queueName: string): Promise<QueueClient> {
    let client = this.queueClients.get(queueName);
    if (!client) {
      client = this.createQueueClient(queueName);
      await client.createIfNotExists();
      this.queueClients.set(queueName, client);
    }
    return client;
  }

  private async loadHandlers(forceFresh = false): Promise<HandlerServiceDocument[]> {
    const now = Date.now();
    if (!forceFresh && this.handlerCache && this.handlerCache.expiresAt > now) {
      return this.handlerCache.docs;
    }
    const docs = (await this.db
      .collection("services")
      .find({ type: "post-process-handler" })
      .toArray()) as unknown as HandlerServiceDocument[];
    this.handlerCache = { docs, expiresAt: now + this.handlerCacheTtlMs };
    return docs;
  }

  /** Drops the cached topology so the next loadHandlers() re-reads from Mongo.
   *  Called after registerHandler persists a change. */
  private invalidateHandlerCache(): void {
    this.handlerCache = null;
  }

  private buildGraph(handlers: HandlerServiceDocument[]): DependencyGraph {
    const nodes = handlers.map((h) => ({ id: h._id, dependsOn: h.dependsOn }));
    return new DependencyGraph(nodes);
  }
}
