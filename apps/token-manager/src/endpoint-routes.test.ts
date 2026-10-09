// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import type { Collection, FindCursor, WithId } from "mongodb";
import type { KeyDocument } from "shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretStore } from "./keyvault-store.js";
import { createKeyRouter } from "./routes.js";

function makeEndpoint(overrides: Partial<KeyDocument> = {}): KeyDocument {
  return {
    _id: "foundry-1",
    type: "azure-ai-foundry",
    capabilities: ["azure-ai-inference"],
    secretName: "token-azure-ai-foundry-foundry",
    lastValidationStatus: "valid",
    enabled: true,
    acquireCount: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeCollection(docs: KeyDocument[]) {
  return {
    find: vi.fn((filter: Record<string, any>) => {
      const matches = docs.filter((doc) => {
        if (filter.enabled !== undefined && doc.enabled !== filter.enabled) return false;
        if (filter.lastValidationStatus && doc.lastValidationStatus !== filter.lastValidationStatus) {
          return false;
        }
        if (filter.deletedAt?.$exists === false && doc.deletedAt) return false;
        if (filter.capabilities?.$in && !filter.capabilities.$in.some(
          (capability: string) => doc.capabilities.includes(capability as any)
        )) return false;
        if (filter.type?.$in && !filter.type.$in.includes(doc.type)) return false;
        return true;
      });
      return {
        toArray: vi.fn(async () => matches),
      } as unknown as FindCursor<WithId<KeyDocument>>;
    }),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  };
}

function makeStore(secrets: Record<string, string>) {
  return {
    getSecret: vi.fn(async (name: string) => {
      const value = secrets[name];
      if (value === undefined) throw new Error(`Secret '${name}' not found`);
      return value;
    }),
  };
}

function makeApp(
  collection: ReturnType<typeof makeCollection>,
  store: ReturnType<typeof makeStore>
) {
  const app = express();
  app.use(express.json());
  app.use(createKeyRouter(
    collection as unknown as Collection<KeyDocument>,
    store as unknown as SecretStore
  ));
  return app;
}

async function request(
  app: express.Express,
  path: string,
  body: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req = {
      method: "POST",
      url: path,
      headers: { "content-type": "application/json" },
      body,
      params: {},
      query: {},
      get: (header: string) => header === "content-type" ? "application/json" : undefined,
    } as unknown as express.Request;
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(data: unknown) {
        resolve({ status, body: data });
      },
      setHeader() {
        return this;
      },
      getHeader() {
        return undefined;
      },
      end() {
        resolve({ status, body: null });
      },
    } as unknown as express.Response;

    (app as any).handle(req, res, (error: Error) => {
      resolve({ status: 500, body: { error: error.message } });
    });
  });
}

describe("structured endpoint acquisition", () => {
  let endpoint: KeyDocument;
  let collection: ReturnType<typeof makeCollection>;
  let store: ReturnType<typeof makeStore>;
  let app: express.Express;

  beforeEach(() => {
    endpoint = makeEndpoint();
    collection = makeCollection([endpoint]);
    store = makeStore({
      [endpoint.secretName]: JSON.stringify({
        endpoint: "https://foundry.example.com/models/",
        apiKey: "foundry-key",
        model: "gpt-4.1-mini",
      }),
    });
    app = makeApp(collection, store);
  });

  it("returns a typed endpoint and records the acquisition", async () => {
    const response = await request(app, "/api/v1/endpoints/acquire", {
      capability: "azure-ai-inference",
    });

    expect(response).toEqual({
      status: 200,
      body: {
        endpoint: "https://foundry.example.com/models",
        apiKey: "foundry-key",
        deployment: "gpt-4.1-mini",
      },
    });
    expect(store.getSecret).toHaveBeenCalledWith(endpoint.secretName);
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: endpoint._id },
      expect.objectContaining({ $inc: { acquireCount: 1 } })
    );
  });

  it("returns 404 when no eligible endpoint exists", async () => {
    collection = makeCollection([makeEndpoint({ enabled: false })]);
    app = makeApp(collection, store);

    const response = await request(app, "/api/v1/endpoints/acquire", {
      capability: "azure-ai-inference",
    });

    expect(response.status).toBe(404);
    expect(response.body.error).toContain("No valid endpoints available");
    expect(store.getSecret).not.toHaveBeenCalled();
  });

  it("returns 422 and does not count malformed stored credentials", async () => {
    store = makeStore({ [endpoint.secretName]: "not-json" });
    app = makeApp(collection, store);

    const response = await request(app, "/api/v1/endpoints/acquire", {
      capability: "azure-ai-inference",
    });

    expect(response.status).toBe(422);
    expect(response.body.error).toContain("malformed");
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it("rejects unsupported endpoint capabilities", async () => {
    const response = await request(app, "/api/v1/endpoints/acquire", {
      capability: "copilot-sdk",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid endpoint capability");
  });

  it.each([undefined, null])("rejects a missing or null request body (%#)", async (body) => {
    const response = await request(app, "/api/v1/endpoints/acquire", body);

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid endpoint capability");
    expect(collection.find).not.toHaveBeenCalled();
    expect(store.getSecret).not.toHaveBeenCalled();
  });

  it("preserves raw key acquisition for existing callers", async () => {
    const response = await request(app, "/api/v1/keys/acquire", {
      capability: "azure-ai-inference",
    });

    expect(response.status).toBe(200);
    expect(response.body.value).toBe(
      JSON.stringify({
        endpoint: "https://foundry.example.com/models/",
        apiKey: "foundry-key",
        model: "gpt-4.1-mini",
      })
    );
    expect(response.body.keyType).toBe("azure-ai-foundry");
  });
});
