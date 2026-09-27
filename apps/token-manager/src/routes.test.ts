// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Collection } from "mongodb";
import type { KeyDocument } from "shared";
import type { SecretStore } from "./keyvault-store.js";

vi.mock("./token-validators.js", () => ({
  validateToken: vi.fn(async () => ({
    status: "valid",
    capabilities: ["azure-ai-inference"],
  })),
}));

import { createKeyRouter } from "./routes.js";

async function request(app: express.Express, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req = {
      method: method.toUpperCase(), url: path,
      headers: { "content-type": "application/json" }, body: body ?? {}, params: {}, query: {},
      get: (h: string) => h === "content-type" ? "application/json" : undefined,
    } as unknown as express.Request;
    let statusCode = 200;
    const res = {
      status(code: number) { statusCode = code; return this; },
      json(data: unknown) { resolve({ status: statusCode, body: data }); },
      send(data?: unknown) { resolve({ status: statusCode, body: data ?? null }); },
      setHeader() { return this; }, getHeader() { return undefined; },
      end() { resolve({ status: statusCode, body: null }); },
    } as unknown as express.Response;
    (app as any).handle(req, res, (err: Error) => resolve({ status: 500, body: { error: err.message } }));
  });
}

function makeKey(type: KeyDocument["type"] = "azure-ai-foundry"): KeyDocument {
  return {
    _id: "key-1", type, capabilities: ["azure-ai-inference"], secretName: "secret-1",
    enabled: true, lastValidationStatus: "valid", acquireCount: 0, createdAt: new Date(),
  };
}

function setup(type: KeyDocument["type"] = "azure-ai-foundry") {
  let doc = makeKey(type);
  const secrets = new Map([["secret-1", JSON.stringify({
    endpoint: "https://example.services.ai.azure.com/models", apiKey: "secret-key", model: "gpt-4.1",
  })]]);
  const collection = {
    findOne: vi.fn(async (filter: any) => filter._id === doc._id ? { ...doc } : null),
    findOneAndUpdate: vi.fn(async (_filter: any, update: any) => {
      doc = { ...doc, ...(update.$set ?? {}) };
      return { ...doc };
    }),
  } as unknown as Collection<KeyDocument>;
  const store = {
    getSecret: vi.fn(async (name: string) => secrets.get(name)!),
    setSecret: vi.fn(async (name: string, value: string) => { secrets.set(name, value); }),
  } as unknown as SecretStore;
  const app = express(); app.use(express.json()); app.use(createKeyRouter(collection, store));
  return { app, store, secrets };
}

describe("key routes - Azure AI Foundry model editing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes the non-sensitive model name without exposing the secret", async () => {
    const { app } = setup();
    const res = await request(app, "GET", "/api/v1/keys/key-1");
    expect(res.status).toBe(200);
    expect(res.body.foundryModel).toBe("gpt-4.1");
    expect(res.body.apiKey).toBeUndefined();
  });

  it("updates only the Foundry model while preserving endpoint and API key", async () => {
    const { app, store, secrets } = setup();
    const res = await request(app, "PUT", "/api/v1/keys/key-1", { foundryModel: "gpt-4.1-mini" });
    expect(res.status).toBe(200);
    expect(store.setSecret).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secrets.get("secret-1")!)).toEqual({
      endpoint: "https://example.services.ai.azure.com/models", apiKey: "secret-key", model: "gpt-4.1-mini",
    });
  });

  it("clears the model override when foundryModel is null", async () => {
    const { app, secrets } = setup();
    const res = await request(app, "PUT", "/api/v1/keys/key-1", { foundryModel: null });
    expect(res.status).toBe(200);
    expect(JSON.parse(secrets.get("secret-1")!)).toEqual({
      endpoint: "https://example.services.ai.azure.com/models", apiKey: "secret-key",
    });
  });

  it("rejects foundryModel updates for non-Foundry keys", async () => {
    const { app, store } = setup("github-pat-classic");
    const res = await request(app, "PUT", "/api/v1/keys/key-1", { foundryModel: "gpt-4.1" });
    expect(res.status).toBe(400);
    expect(store.setSecret).not.toHaveBeenCalled();
  });
});
