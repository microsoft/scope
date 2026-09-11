// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import request from "supertest";
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTAL_AI_PROVIDERS } from "shared";
import { registerSecretsRoutes } from "./secrets.js";

function createApp() {
  const app = express();
  app.use(express.json());
  const registry = new OpenAPIRegistry();
  registerSecretsRoutes({ app, registry });
  return { app, registry };
}

beforeEach(() => vi.stubEnv("TOKEN_MANAGER_URL", "http://token-manager.test"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Portal AI public settings routes", () => {
  it("registers GET, PUT and their concrete canonical schemas in OpenAPI", () => {
    const { registry } = createApp();
    const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
      openapi: "3.1.0", info: { title: "Secrets", version: "1" },
    });
    const route = document.paths["/api/v1/keys/portal-ai"];
    expect(route?.get?.responses["200"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/PortalAiSettings" } } },
    });
    expect(route?.put?.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/UpdatePortalAiSettings" } } },
    });
    expect(route?.put?.responses["200"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/PortalAiSettings" } } },
    });
    expect(document.components?.schemas?.PortalAiSettings).toMatchObject({
      type: "object",
      required: ["provider"],
      properties: {
        provider: { type: "string", enum: [...PORTAL_AI_PROVIDERS] },
        keyId: { type: "string", minLength: 1, pattern: "\\S" },
        model: { type: "string", minLength: 1, pattern: "\\S" },
      },
    });
  });

  it("proxies GET settings without changing the upstream body or status", async () => {
    const settings = { provider: "openai", keyId: "key-1", model: "gpt-4.1" };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(settings));
    await request(createApp().app).get("/api/v1/keys/portal-ai").expect(200, settings);
    expect(fetch).toHaveBeenCalledWith("http://token-manager.test/api/v1/keys/portal-ai", expect.objectContaining({ method: "GET" }));
  });

  it("validates and forwards a PUT selection to the existing proxy", async () => {
    const settings = { provider: "anthropic", keyId: "key-1", model: "claude-test" };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(settings));
    await request(createApp().app).put("/api/v1/keys/portal-ai").send(settings).expect(200, settings);
    expect(fetch).toHaveBeenCalledWith("http://token-manager.test/api/v1/keys/portal-ai", expect.objectContaining({
      method: "PUT", body: JSON.stringify(settings),
    }));
  });

  it.each([
    {},
    { provider: "unsupported" },
    { provider: "openai", keyId: "" },
    { provider: "openai", keyId: "   " },
    { provider: "openai", model: 123 },
    { provider: "openai", model: "   " },
    { provider: "auto", keyId: "key-1" },
    { provider: "auto", model: "gpt-4.1" },
  ])("rejects invalid settings before contacting Token Manager: %j", async (body) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream call"));
    await request(createApp().app).put("/api/v1/keys/portal-ai").send(body).expect(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves Token Manager credential-validation errors without retrying", async () => {
    const error = { error: "Select a valid, enabled, unexpired key for this provider" };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(error, { status: 400 }));
    await request(createApp().app).put("/api/v1/keys/portal-ai")
      .send({ provider: "openai", keyId: "missing-key" }).expect(400, error);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps new routes discoverable when Token Manager is disabled, without enabling old CRUD", async () => {
    vi.stubEnv("TOKEN_MANAGER_URL", "");
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream call"));
    const { app, registry } = createApp();
    await request(app).get("/api/v1/keys/portal-ai").expect(503, { error: "Token Manager is not configured" });
    await request(app).put("/api/v1/keys/portal-ai").send({ provider: "auto" }).expect(503);
    await request(app).get("/api/v1/keys").expect(404);
    const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
      openapi: "3.1.0", info: { title: "Secrets", version: "1" },
    });
    expect(document.paths["/api/v1/keys/portal-ai"]?.get).toBeDefined();
    expect(document.paths["/api/v1/keys/portal-ai"]?.put).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not convert existing key creation into a schema-validated route", async () => {
    const body = { type: "existing-provider", value: "opaque-test-value", extraField: true };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ _id: "key-1" }, { status: 201 }));
    await request(createApp().app).post("/api/v1/keys").send(body).expect(201, { _id: "key-1" });
    expect(fetch).toHaveBeenCalledWith("http://token-manager.test/api/v1/keys", expect.objectContaining({
      method: "POST", body: JSON.stringify(body),
    }));
  });
});
