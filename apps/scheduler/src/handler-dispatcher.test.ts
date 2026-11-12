// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HandlerServiceDocument } from "shared";
import { HandlerDispatcher } from "./handler-dispatcher.js";

const HANDLERS: HandlerServiceDocument[] = [
  {
    _id: "pp-atif",
    type: "post-process-handler",
    version: 1,
    queue: "post-processor-queue",
    selector: "atif",
    autoBackfill: true,
    dependsOn: [],
  },
  {
    _id: "pp-example",
    type: "post-process-handler",
    version: 1,
    queue: "pp-example-queue",
    selector: "example",
    autoBackfill: false,
    dependsOn: ["pp-atif"],
  },
];

function createMockCollection() {
  return {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    find: vi.fn(),
  } as any;
}

function createMockDb(handlers: HandlerServiceDocument[]) {
  return {
    collection: vi.fn().mockReturnValue({
      find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(handlers) }),
      updateOne: vi.fn().mockResolvedValue(undefined),
    }),
  } as any;
}

function makeDispatcher(
  collection: any,
  handlers: HandlerServiceDocument[] = HANDLERS,
  apiUrl = "http://api.test",
) {
  const db = createMockDb(handlers);
  const createQueueClient = vi.fn();
  return new HandlerDispatcher(collection, db, createQueueClient, 60_000, 30, apiUrl);
}

function makeDispatcherWithQueue(
  collection: any,
  handlers: HandlerServiceDocument[] = HANDLERS,
  apiUrl = "http://api.test",
) {
  const db = createMockDb(handlers);
  const queueClient = {
    createIfNotExists: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
  const createQueueClient = vi.fn().mockReturnValue(queueClient);
  const dispatcher = new HandlerDispatcher(collection, db, createQueueClient, 60_000, 30, apiUrl);
  return { dispatcher, queueClient, createQueueClient };
}

describe("HandlerDispatcher — drain detection", () => {
  let collection: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    collection = createMockCollection();
  });

  function isDrained(
    handlers: HandlerServiceDocument[],
    handlerStatus: Record<string, { status: string }> | undefined,
  ): boolean {
    const d = makeDispatcher(collection, handlers) as any;
    const graph = d.buildGraph(handlers);
    return d.isDagDrained(handlers, graph, handlerStatus);
  }

  it("is drained when all handlers are done", () => {
    expect(
      isDrained(HANDLERS, { "pp-atif": { status: "done" }, "pp-example": { status: "done" } }),
    ).toBe(true);
  });

  it("is NOT drained when the leaf is still pending", () => {
    expect(isDrained(HANDLERS, { "pp-atif": { status: "done" } })).toBe(false);
  });

  it("is NOT drained when a handler is processing", () => {
    expect(
      isDrained(HANDLERS, {
        "pp-atif": { status: "done" },
        "pp-example": { status: "processing" },
      }),
    ).toBe(false);
  });

  it("is drained when a failed dependency blocks its descendant", () => {
    // pp-atif failed → pp-example can never run (blocked) → terminal.
    expect(isDrained(HANDLERS, { "pp-atif": { status: "failed" } })).toBe(true);
  });

  it("is drained when the leaf itself failed", () => {
    expect(
      isDrained(HANDLERS, {
        "pp-atif": { status: "done" },
        "pp-example": { status: "failed" },
      }),
    ).toBe(true);
  });

  it("is vacuously drained when there are no handlers", () => {
    expect(isDrained([], undefined)).toBe(true);
  });
});

describe("HandlerDispatcher — maybeTriggerReports", () => {
  let collection: ReturnType<typeof createMockCollection>;
  const fetchMock = vi.fn();

  beforeEach(() => {
    collection = createMockCollection();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to /api/v1/reports/trigger once the DAG drains", async () => {
    collection.findOne.mockResolvedValue({
      _id: "req-1",
      run: {
        _id: "run-1",
        status: "done",
        handlerStatus: { "pp-atif": { status: "done" }, "pp-example": { status: "done" } },
      },
    });
    collection.findOneAndUpdate.mockResolvedValue({ _id: "req-1" }); // claim succeeds
    fetchMock.mockResolvedValue({ ok: true, status: 201, text: async () => "" });

    const d = makeDispatcher(collection) as any;
    await d.maybeTriggerReports("req-1", "run-1");

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "req-1",
        "run._id": "run-1",
        "run.status": "done",
        "run.reportsTriggeredAt": { $exists: false },
      }),
      expect.objectContaining({ $set: expect.objectContaining({ "run.reportsTriggeredAt": expect.any(Date) }) }),
      expect.objectContaining({ returnDocument: "after" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/api/v1/reports/trigger");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ requestId: "req-1" });
  });

  it("does not trigger when the DAG has not drained", async () => {
    collection.findOne.mockResolvedValue({
      _id: "req-1",
      run: { _id: "run-1", status: "done", handlerStatus: { "pp-atif": { status: "done" } } },
    });

    const d = makeDispatcher(collection) as any;
    await d.maybeTriggerReports("req-1", "run-1");

    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not trigger when reports were already triggered", async () => {
    collection.findOne.mockResolvedValue({
      _id: "req-1",
      run: { _id: "run-1", status: "done", reportsTriggeredAt: new Date(), handlerStatus: {} },
    });

    const d = makeDispatcher(collection) as any;
    await d.maybeTriggerReports("req-1", "run-1");

    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not trigger when the current attempt differs from the notified runId", async () => {
    // A stale notify for run-1 arrives, but the request has since been retried
    // into run-2 — the guard must not fire for the wrong attempt.
    collection.findOne.mockResolvedValue({
      _id: "req-1",
      run: {
        _id: "run-2",
        status: "done",
        handlerStatus: { "pp-atif": { status: "done" }, "pp-example": { status: "done" } },
      },
    });

    const d = makeDispatcher(collection) as any;
    await d.maybeTriggerReports("req-1", "run-1");

    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not POST twice when the guard claim is lost to a concurrent path", async () => {
    collection.findOne.mockResolvedValue({
      _id: "req-1",
      run: {
        _id: "run-1",
        status: "done",
        handlerStatus: { "pp-atif": { status: "done" }, "pp-example": { status: "done" } },
      },
    });
    collection.findOneAndUpdate.mockResolvedValue(null); // another path claimed it first

    const d = makeDispatcher(collection) as any;
    await d.maybeTriggerReports("req-1", "run-1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rolls back the guard when the trigger POST fails", async () => {
    collection.findOne.mockResolvedValue({
      _id: "req-1",
      run: {
        _id: "run-1",
        status: "done",
        handlerStatus: { "pp-atif": { status: "done" }, "pp-example": { status: "done" } },
      },
    });
    collection.findOneAndUpdate.mockResolvedValue({ _id: "req-1" });
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });

    const d = makeDispatcher(collection) as any;
    d.reportRetryOptions = { maxRetries: 1, baseDelayMs: 1, isRetryable: () => true };
    await d.maybeTriggerReports("req-1", "run-1");

    // Guard rolled back via $unset (scoped to the attempt) so the poll net retries.
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: "req-1", "run._id": "run-1" },
      { $unset: { "run.reportsTriggeredAt": "" } },
    );
  });

  it("ignores runs that are not done", async () => {
    collection.findOne.mockResolvedValue({ _id: "req-1", run: { _id: "run-1", status: "processing" } });

    const d = makeDispatcher(collection) as any;
    await d.maybeTriggerReports("req-1", "run-1");

    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HandlerDispatcher — onHandlerComplete", () => {
  let collection: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    collection = createMockCollection();
  });

  it("only accepts completion when current handler status is processing", async () => {
    const d = makeDispatcher(collection) as any;
    const maybeTriggerReportsSpy = vi
      .spyOn(d, "maybeTriggerReports")
      .mockResolvedValue(undefined);

    await d.onHandlerComplete("req-1", "run-1", "pp-atif", "failed");

    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: "req-1", "run.handlerStatus.pp-atif.status": "processing" },
      {
        $set: {
          "run.handlerStatus.pp-atif.status": "failed",
          "run.handlerStatus.pp-atif.updatedAt": expect.any(Date),
        },
      },
    );
    expect(maybeTriggerReportsSpy).toHaveBeenCalledWith("req-1", "run-1");
  });

  it("ignores stale or duplicate completion notifications", async () => {
    collection.updateOne.mockResolvedValue({ matchedCount: 0 });
    const d = makeDispatcher(collection) as any;
    const maybeTriggerReportsSpy = vi
      .spyOn(d, "maybeTriggerReports")
      .mockResolvedValue(undefined);
    const loadHandlersSpy = vi.spyOn(d, "loadHandlers");

    await d.onHandlerComplete("req-1", "run-1", "pp-atif", "done");

    expect(maybeTriggerReportsSpy).not.toHaveBeenCalled();
    expect(loadHandlersSpy).not.toHaveBeenCalled();
  });
});

describe("HandlerDispatcher — handler topology caching", () => {
  function makeWithSpies(ttlMs = 60_000, handlers: HandlerServiceDocument[] = HANDLERS) {
    const collection = createMockCollection();
    const toArray = vi.fn().mockResolvedValue(handlers);
    const find = vi.fn().mockReturnValue({ toArray });
    const servicesUpdateOne = vi.fn().mockResolvedValue(undefined);
    const db = {
      collection: vi.fn().mockReturnValue({ find, updateOne: servicesUpdateOne }),
    } as any;
    const dispatcher = new HandlerDispatcher(
      collection,
      db,
      vi.fn(),
      60_000,
      30,
      "http://api.test",
      ttlMs,
    ) as any;
    return { dispatcher, find, toArray, servicesUpdateOne };
  }

  it("reuses cached topology within the TTL window", async () => {
    const { dispatcher, toArray } = makeWithSpies(60_000);

    await dispatcher.loadHandlers();
    await dispatcher.loadHandlers();

    expect(toArray).toHaveBeenCalledTimes(1);
  });

  it("re-reads topology once the TTL has elapsed", async () => {
    const { dispatcher, toArray } = makeWithSpies(0); // TTL 0 → every read is stale

    await dispatcher.loadHandlers();
    await dispatcher.loadHandlers();

    expect(toArray).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cache when a handler is registered", async () => {
    const { dispatcher, toArray } = makeWithSpies(60_000);

    await dispatcher.loadHandlers(); // read #1 — populates cache
    await dispatcher.registerHandler({
      _id: "pp-new",
      type: "post-process-handler",
      version: 1,
      queue: "pp-new-queue",
      selector: "new",
      autoBackfill: false,
      dependsOn: [],
    }); // read #2 (forceFresh validation) + invalidate
    await dispatcher.loadHandlers(); // read #3 — cache was invalidated

    expect(toArray).toHaveBeenCalledTimes(3);
  });
});

describe("HandlerDispatcher — buildDispatchFilter", () => {
  let collection: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    collection = createMockCollection();
  });

  it("allows done runs to be considered for autoBackfill version bumps", () => {
    const d = makeDispatcher(collection) as any;
    const autoBackfillHandler = HANDLERS[0];

    const filter = d.buildDispatchFilter(autoBackfillHandler, HANDLERS, d.buildGraph(HANDLERS));

    expect(filter[`run.handlerStatus.${autoBackfillHandler._id}.status`]).toEqual({
      $nin: ["queued", "processing"],
    });
    expect(filter.$or).toEqual([
      { [`run.handlerStatus.${autoBackfillHandler._id}.version`]: { $exists: false } },
      { [`run.handlerStatus.${autoBackfillHandler._id}.version`]: { $lt: autoBackfillHandler.version } },
    ]);
  });

  it("keeps done runs excluded for non-backfill handlers", () => {
    const d = makeDispatcher(collection) as any;
    const noBackfillHandler = HANDLERS[1];

    const filter = d.buildDispatchFilter(noBackfillHandler, HANDLERS, d.buildGraph(HANDLERS));

    expect(filter[`run.handlerStatus.${noBackfillHandler._id}.status`]).toEqual({
      $nin: ["queued", "processing", "done"],
    });
  });

  describe("HandlerDispatcher — dispatchIfEligible", () => {
    let collection: ReturnType<typeof createMockCollection>;

    beforeEach(() => {
      collection = createMockCollection();
    });

    it("allows autoBackfill re-dispatch for outdated done versions", async () => {
      collection.findOne.mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          handlerStatus: {
            "pp-atif": { status: "done", version: 0 },
          },
        },
      });
      collection.updateOne.mockResolvedValue({ matchedCount: 1 });

      const { dispatcher, queueClient } = makeDispatcherWithQueue(collection);
      await (dispatcher as any).dispatchIfEligible(
        "req-1",
        "run-1",
        HANDLERS[0],
        (dispatcher as any).buildGraph(HANDLERS),
        HANDLERS,
      );

      expect(queueClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(collection.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: "req-1",
          "run._id": "run-1",
          "run.status": "done",
          "run.handlerStatus.pp-atif.status": { $nin: ["queued", "processing"] },
          $or: [
            { "run.handlerStatus.pp-atif.version": { $exists: false } },
            { "run.handlerStatus.pp-atif.version": { $lt: 1 } },
          ],
        }),
        {
          $set: {
            "run.handlerStatus.pp-atif.status": "queued",
            "run.handlerStatus.pp-atif.updatedAt": expect.any(Date),
          },
        },
      );
    });

    it("enqueues before marking the handler queued", async () => {
      collection.findOne.mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-1", status: "done", handlerStatus: {} },
      });
      collection.updateOne.mockResolvedValue({ matchedCount: 1 });

      const { dispatcher, queueClient } = makeDispatcherWithQueue(collection);
      await (dispatcher as any).dispatchIfEligible(
        "req-1",
        "run-1",
        HANDLERS[0],
        (dispatcher as any).buildGraph(HANDLERS),
        HANDLERS,
      );

      expect(queueClient.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
        collection.updateOne.mock.invocationCallOrder[0],
      );
    });
  });
});
