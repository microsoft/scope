// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Collection } from "mongodb";
import type { KeyDocument, PortalAiSettingsDocument } from "shared";
import { createKeyRouter } from "./routes.js";
import type { SecretStore } from "./keyvault-store.js";

vi.mock("./token-validators.js", () => ({
  validateToken: vi.fn(async () => ({ status: "valid", capabilities: ["openai-api"] })),
}));

const key: KeyDocument = {
  _id: "key-1", type: "openai-api-key", capabilities: ["openai-api"], secretName: "token-openai-key-1",
  enabled: true, lastValidationStatus: "valid", acquireCount: 0, createdAt: new Date(),
};
const find = vi.fn();
const findOne = vi.fn();
const updateOne = vi.fn();
const insertOne = vi.fn();
const getSecret = vi.fn();
const setSecret = vi.fn();
let saved: PortalAiSettingsDocument | null;
const settingsFind = vi.fn();
const replaceOne = vi.fn();

function makeApp() {
  const app = express();
  app.use(createKeyRouter(
    { find, findOne, updateOne, insertOne } as unknown as Collection<KeyDocument>,
    { getSecret, setSecret } as unknown as SecretStore,
    { findOne: settingsFind, replaceOne } as unknown as Collection<PortalAiSettingsDocument>,
  ));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(500).json({ error: err.message }));
  return app;
}

function request(app: express.Express, method: string, path: string, body: unknown = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 200;
    const req = { method, url: path, body, headers: {}, query: {} } as unknown as express.Request;
    const res = {
      status(code: number) { status = code; return this; },
      json(data: unknown) { resolve({ status, body: data }); return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
      end() { resolve({ status, body: undefined }); },
    } as unknown as express.Response;
    app(req, res);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  saved = null;
  find.mockReturnValue({ toArray: async () => [key] });
  findOne.mockResolvedValue(key);
  updateOne.mockResolvedValue({});
  insertOne.mockResolvedValue({});
  setSecret.mockResolvedValue(undefined);
  getSecret.mockResolvedValue('{"endpoint":"https://api.openai.com/v1","apiKey":"test-private","model":"gpt-4.1"}');
  settingsFind.mockImplementation(async () => saved);
  replaceOne.mockImplementation(async (_filter, doc: PortalAiSettingsDocument) => { saved = doc; });
});

describe("Portal provider key management", () => {
  it("registers new provider secrets in vault without returning the secret", async () => {
    const result = await request(makeApp(), "POST", "/api/v1/keys", {
      type: "openai-api-key", value: '{"endpoint":"https://api.openai.com/v1","apiKey":"test-private","model":"gpt-4.1"}',
    });
    expect(result.status).toBe(201);
    expect(setSecret).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.body)).not.toContain("test-private");
    expect(JSON.stringify(insertOne.mock.calls)).not.toContain("test-private");
  });

  it("rejects malformed endpoint/model before storing a provider secret", async () => {
    const result = await request(makeApp(), "POST", "/api/v1/keys", {
      type: "openai-compatible", value: '{"endpoint":"http://external.test/v1","apiKey":"test","model":"custom"}',
    });
    expect(result.status).toBe(400);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("persists and reads a non-secret Portal-only selection using one singleton _id", async () => {
    const app = makeApp();
    expect((await request(app, "GET", "/api/v1/keys/portal-ai")).body).toEqual({ provider: "auto" });
    const result = await request(app, "PUT", "/api/v1/keys/portal-ai", { provider: "openai", keyId: "key-1", model: "gpt-4.1-mini" });
    expect(result).toEqual({ status: 200, body: { provider: "openai", keyId: "key-1", model: "gpt-4.1-mini" } });
    expect(replaceOne).toHaveBeenCalledWith({ _id: "default" }, {
      _id: "default", provider: "openai", keyId: "key-1", model: "gpt-4.1-mini",
    }, { upsert: true });
    expect((await request(app, "GET", "/api/v1/keys/portal-ai")).body).toEqual(result.body);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("rejects a key that does not belong to the selected provider", async () => {
    findOne.mockResolvedValue(null);
    const result = await request(makeApp(), "PUT", "/api/v1/keys/portal-ai", { provider: "anthropic", keyId: "key-1" });
    expect(result.status).toBe(400);
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ _id: "key-1", type: "anthropic-api-key" }));
  });

  it("resets the whole selection when automatic mode is restored", async () => {
    const app = makeApp();
    await request(app, "PUT", "/api/v1/keys/portal-ai", { provider: "openai", keyId: "key-1" });
    await request(app, "PUT", "/api/v1/keys/portal-ai", { provider: "auto" });
    expect(saved).toEqual({ _id: "default", provider: "auto" });
  });

  it("acquires only the explicit provider type and key without allowing a preference fallback", async () => {
    const result = await request(makeApp(), "POST", "/api/v1/keys/acquire", {
      capability: "openai-api", keyType: "openai-api-key", strictKeyType: true, keyId: "key-1",
    });
    expect(result.status).toBe(200);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ type: "openai-api-key", _id: "key-1", enabled: true }));
    expect(getSecret).toHaveBeenCalledWith("token-openai-key-1");
  });

  it("round robins within the selected credential type", async () => {
    find.mockReturnValue({ toArray: async () => [key, { ...key, _id: "key-2", secretName: "token-openai-key-2" }] });
    const app = makeApp();
    const body = { capability: "openai-api", keyType: "openai-api-key", strictKeyType: true };
    await request(app, "POST", "/api/v1/keys/acquire", body);
    await request(app, "POST", "/api/v1/keys/acquire", body);
    expect(getSecret.mock.calls.map(([name]) => name)).toEqual(["token-openai-key-1", "token-openai-key-2"]);
  });

  it("does not acquire expired credentials even if the scheduler still marks them valid", async () => {
    find.mockReturnValue({ toArray: async () => [{ ...key, expiresAt: new Date(0) }] });
    const result = await request(makeApp(), "POST", "/api/v1/keys/acquire", { capability: "openai-api" });
    expect(result.status).toBe(404);
    expect(getSecret).not.toHaveBeenCalled();
  });
});
