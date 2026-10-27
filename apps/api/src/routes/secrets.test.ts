// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import request from "supertest";
import { MongoClient } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Authorization } from "../auth/authorization.js";
import { AccessError } from "../auth/admin-operations.js";
import { registerSecretsRoutes } from "./secrets.js";

const client = new MongoClient("mongodb://127.0.0.1:1");
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("TOKEN_MANAGER_URL", "http://token-manager.test");
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function app() {
  const server = express();
  server.use(express.json());
  registerSecretsRoutes({ app: server, db: client.db("unused_unit_fixture"), authEnabled: true });
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AccessError ? error.status : 500).json({ error: error.message });
  });
  return server;
}

const routes = [
  ["get", "/keys"], ["post", "/keys"], ["post", "/keys/preview"],
  ["get", "/keys/example"], ["put", "/keys/example"], ["delete", "/keys/example"],
  ["post", "/keys/example/validate"], ["get", "/accounts"], ["post", "/accounts"],
  ["get", "/accounts/example"], ["put", "/accounts/example"], ["delete", "/accounts/example"],
] as const;

describe("Global Secrets proxy", () => {
  it.each(routes)("requires platform authorization for %s %s without a project", async (method, path) => {
    const guard = vi.spyOn(Authorization.prototype, "guard").mockResolvedValue(1);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ managed: true }), { headers: { "content-type": "application/json" } }));
    const response = await request(app())[method](`/api/v1${path}`).send(method === "get" ? undefined : { comment: "metadata" });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(guard).toHaveBeenCalledWith(expect.anything(), method, `/api/v1${path}`, "platform");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(`http://token-manager.test/api/v1${path}`, expect.objectContaining({
      method: method.toUpperCase(), signal: expect.any(AbortSignal),
    }));
  });

  it.each([401, 403])("denies unauthorized access with HTTP %s before contacting Token Manager", async status => {
    vi.spyOn(Authorization.prototype, "guard").mockRejectedValue(new AccessError(status, "access_denied", "Platform administration required"));
    expect((await request(app()).post("/api/v1/keys").send({})).status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps protected routes registered and returns an actionable503 when Token Manager is not configured", async () => {
    vi.stubEnv("TOKEN_MANAGER_URL", "");
    vi.spyOn(Authorization.prototype, "guard").mockResolvedValue(1);
    const response = await request(app()).get("/api/v1/keys");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "token_manager_unavailable", error: expect.stringContaining("TOKEN_MANAGER_URL") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["fetch", "body", "timeout"])("surfaces a sanitized503 for an upstream %s failure without replaying a create", async failure => {
    vi.spyOn(Authorization.prototype, "guard").mockResolvedValue(1);
    if (failure === "body") {
      const response = new Response("unused");
      vi.spyOn(response, "text").mockRejectedValue(new Error("sensitive upstream detail"));
      fetchMock.mockResolvedValue(response);
    } else {
      fetchMock.mockRejectedValue(failure === "timeout"
        ? new DOMException("sensitive upstream detail", "TimeoutError") : new TypeError("sensitive upstream detail"));
    }
    const response = await request(app()).post("/api/v1/keys").send({ value: "test-only-never-log" });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: "token_manager_unavailable",
      error: "Secrets service is unavailable. Check that Token Manager and its secret store are running, then try again.",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith("[api] Token Manager request failed", "POST", "/api/v1/keys");
  });

  it("preserves upstream validation errors instead of claiming success", async () => {
    vi.spyOn(Authorization.prototype, "guard").mockResolvedValue(1);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Invalid key type" }), { status: 400, headers: { "content-type": "application/json" } }));
    const response = await request(app()).post("/api/v1/keys").send({});
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid key type" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([500, 502, 503])("normalizes upstream HTTP %s secret-store failures without exposing internal errors", async status => {
    vi.spyOn(Authorization.prototype, "guard").mockResolvedValue(1);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "fetch failed: internal secret-store details" }), { status }));
    const response = await request(app()).post("/api/v1/keys").send({});
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "token_manager_unavailable", error: expect.stringContaining("secret store") });
    expect(JSON.stringify(response.body)).not.toContain("internal");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
