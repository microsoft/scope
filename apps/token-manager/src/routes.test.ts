// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection } from "mongodb";
import type { KeyDocument } from "shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretStore } from "./keyvault-store.js";
import { createKeyRouter } from "./routes.js";
import { validateToken } from "./token-validators.js";

vi.mock("./token-validators.js", () => ({
  validateToken: vi.fn(),
}));

const token: KeyDocument = {
  _id: "foundry-key",
  type: "azure-ai-foundry",
  capabilities: ["azure-ai-inference"],
  secretName: "token-azure-ai-foundry-foundry",
  enabled: true,
  lastValidationStatus: "valid",
  acquireCount: 0,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};

function getPutHandler(
  collection: Collection<KeyDocument>,
  store: SecretStore
) {
  const router = createKeyRouter(collection, store) as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (...args: any[]) => Promise<void> }>;
      };
    }>;
  };
  const layer = router.stack.find(
    (candidate) =>
      candidate.route?.path === "/api/v1/keys/:id" &&
      candidate.route.methods.put
  );
  if (!layer?.route) throw new Error("PUT key route not found");
  return layer.route.stack[0].handle;
}

function makeResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

function makeStore(events: string[]) {
  let value = JSON.stringify({
    endpoint: "https://example.services.ai.azure.com/models",
    apiKey: "secret-api-key",
    model: "old-model",
  });
  return {
    getSecret: vi.fn(async () => value),
    setSecret: vi.fn(async (_name: string, next: string) => {
      events.push("write-secret");
      value = next;
    }),
    deleteSecret: vi.fn(),
  } satisfies SecretStore;
}

describe("Foundry model update route", () => {
  beforeEach(() => {
    vi.mocked(validateToken).mockResolvedValue({
      status: "valid",
      capabilities: ["azure-ai-inference"],
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it("marks validation pending before writing Key Vault and guards the result", async () => {
    const events: string[] = [];
    let validationRevision: string | undefined;
    const collection = {
      findOne: vi.fn(async () => token),
      findOneAndUpdate: vi.fn(async (_filter, update) => {
        events.push("mark-pending");
        validationRevision = update.$set.validationRevision as string;
        return { ...token, ...update.$set };
      }),
      updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
    } as unknown as Collection<KeyDocument>;
    const store = makeStore(events);
    const response = makeResponse();
    const next = vi.fn();

    await getPutHandler(collection, store)(
      {
        params: { id: token._id },
        body: { model: "new-model" },
      },
      response,
      next
    );

    expect(events).toEqual(["mark-pending", "write-secret"]);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: token._id, deletedAt: { $exists: false } },
      {
        $set: expect.objectContaining({
          lastValidationStatus: "unknown",
          lastValidatedAt: null,
          lastValidationError: null,
        }),
      },
      { returnDocument: "after" }
    );
    await vi.waitFor(() => expect(collection.updateOne).toHaveBeenCalled());
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: token._id, validationRevision, deletedAt: { $exists: false } },
      expect.any(Object)
    );
    expect(response.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves the database state pending when the Key Vault write fails", async () => {
    const events: string[] = [];
    const collection = {
      findOne: vi.fn(async () => token),
      findOneAndUpdate: vi.fn(async (_filter, update) => {
        events.push("mark-pending");
        return { ...token, ...update.$set };
      }),
      updateOne: vi.fn(),
    } as unknown as Collection<KeyDocument>;
    const store = makeStore(events);
    const writeError = new Error("Key Vault unavailable");
    store.setSecret.mockImplementation(async () => {
      events.push("write-secret");
      throw writeError;
    });
    const response = makeResponse();
    const next = vi.fn();

    await getPutHandler(collection, store)(
      {
        params: { id: token._id },
        body: { model: "new-model" },
      },
      response,
      next
    );

    expect(events).toEqual(["mark-pending", "write-secret"]);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      {
        $set: expect.objectContaining({ lastValidationStatus: "unknown" }),
      },
      expect.any(Object)
    );
    expect(validateToken).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(writeError);
  });

  it.each(["old-model", " old-model "])("preserves validation when an API client sends the same model: %s", async (model) => {
    const collection = {
      findOne: vi.fn(async () => token),
      findOneAndUpdate: vi.fn(async (_filter, update) => ({ ...token, ...update.$set })),
      updateOne: vi.fn(),
    } as unknown as Collection<KeyDocument>;
    const store = makeStore([]);
    const response = makeResponse();
    const next = vi.fn();
    await getPutHandler(collection, store)(
      { params: { id: token._id }, body: { model, comment: "metadata only" } },
      response, next
    );
    const update = vi.mocked(collection.findOneAndUpdate).mock.calls[0][1];
    expect(update.$set).toMatchObject({ comment: "metadata only" });
    expect(update.$set).not.toHaveProperty("lastValidationStatus");
    expect(update.$set).not.toHaveProperty("validationRevision");
    expect(store.setSecret).not.toHaveBeenCalled();
    expect(validateToken).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ lastValidationStatus: "valid" }));
    expect(next).not.toHaveBeenCalled();
  });

  function makeStatefulCollection() {
    let current = { ...token };
    const matches = (filter: Record<string, unknown>) =>
      (!("validationRevision" in filter) || filter.validationRevision === current.validationRevision)
      && !current.deletedAt;
    const collection = {
      findOne: vi.fn(async () => ({ ...current })),
      findOneAndUpdate: vi.fn(async (_filter, update) => {
        current = { ...current, ...update.$set };
        return { ...current };
      }),
      updateOne: vi.fn(async (filter, update) => {
        if (!matches(filter)) return { modifiedCount: 0 };
        current = { ...current, ...update.$set };
        return { modifiedCount: 1 };
      }),
    } as unknown as Collection<KeyDocument>;
    return { collection, getCurrent: () => current };
  }

  it("applies an in-flight validation after a metadata-only save", async () => {
    const { collection, getCurrent } = makeStatefulCollection();
    const store = makeStore([]);
    const handler = getPutHandler(collection, store);
    let finish!: (result: { status: "valid" }) => void;
    vi.mocked(validateToken).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await handler({ params: { id: token._id }, body: { model: "new-model" } }, makeResponse(), vi.fn());
    const revision = getCurrent().validationRevision;
    await vi.waitFor(() => expect(validateToken).toHaveBeenCalledOnce());
    await handler({ params: { id: token._id }, body: { comment: "later metadata" } }, makeResponse(), vi.fn());
    expect(getCurrent().validationRevision).toBe(revision);
    expect(store.setSecret).toHaveBeenCalledTimes(1);
    finish({ status: "valid" });
    await vi.waitFor(() => expect(getCurrent().lastValidationStatus).toBe("valid"));
    expect(getCurrent().comment).toBe("later metadata");
  });

  it("discards an old result even when two edits share a timestamp", async () => {
    const { collection, getCurrent } = makeStatefulCollection();
    const handler = getPutHandler(collection, makeStore([]));
    const completions: Array<(result: { status: "valid" | "invalid" }) => void> = [];
    vi.mocked(validateToken).mockImplementation(() => new Promise((resolve) => { completions.push(resolve); }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    await handler({ params: { id: token._id }, body: { model: "model-a" } }, makeResponse(), vi.fn());
    const revisionA = getCurrent().validationRevision;
    await handler({ params: { id: token._id }, body: { model: "model-b" } }, makeResponse(), vi.fn());
    expect(getCurrent().validationRevision).not.toBe(revisionA);
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    completions[1]({ status: "valid" });
    await vi.waitFor(() => expect(getCurrent().lastValidationStatus).toBe("valid"));
    completions[0]({ status: "invalid" });
    await vi.waitFor(() => expect(collection.updateOne).toHaveBeenCalledTimes(2));
    expect(getCurrent().lastValidationStatus).toBe("valid");
    vi.useRealTimers();
  });

  it("validates the value read back from storage rather than a captured write", async () => {
    const { collection } = makeStatefulCollection();
    const store = makeStore([]);
    const actual = JSON.stringify({ endpoint: "https://example.services.ai.azure.com/models", apiKey: "secret-api-key", model: "concurrent-model" });
    store.getSecret.mockResolvedValueOnce(JSON.stringify({
      endpoint: "https://example.services.ai.azure.com/models", apiKey: "secret-api-key", model: "old-model",
    }));
    store.getSecret.mockResolvedValue(actual);
    await getPutHandler(collection, store)(
      { params: { id: token._id }, body: { model: "requested-model" } }, makeResponse(), vi.fn()
    );
    await vi.waitFor(() => expect(validateToken).toHaveBeenCalledWith("azure-ai-foundry", actual));
    expect(store.getSecret).toHaveBeenCalledWith(token.secretName, { bypassCache: true });
  });

});
