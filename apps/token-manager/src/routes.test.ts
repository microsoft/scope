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
    vi.clearAllMocks();
  });

  it("marks validation pending before writing Key Vault and guards the result", async () => {
    const events: string[] = [];
    let updateRevision: Date | undefined;
    const collection = {
      findOne: vi.fn(async () => token),
      findOneAndUpdate: vi.fn(async (_filter, update) => {
        events.push("mark-pending");
        updateRevision = update.$set.updatedAt as Date;
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
      { _id: token._id, updatedAt: updateRevision },
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
});
