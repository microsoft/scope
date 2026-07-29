// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import express from "express";
import request from "supertest";
import type { RouteContext } from "../route-context.js";
import { registerMcpServersRoutes } from "./mcp-servers.js";
import type { McpSecretClient, McpSecretListItem } from "@scope/agent-protocol";

extendZodWithOpenApi(z);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeListItem(name: string): McpSecretListItem {
  return { id: name, mcpId: "srv-1", name, createdAt: "", updatedAt: "" };
}

function buildCtx(overrides: {
  mcpSecretClient?: McpSecretClient | null;
  findOneSpy?: ReturnType<typeof vi.fn>;
  updateOneSpy?: ReturnType<typeof vi.fn>;
}): { app: ReturnType<typeof express>; ctx: RouteContext } {
  const app = express();
  app.use(express.json());

  const registry = new OpenAPIRegistry();

  const findOneSpy =
    overrides.findOneSpy ??
    vi.fn().mockResolvedValue({
      _id: "srv-1",
      name: "Test Server",
      type: "stdio",
      createdAt: new Date(),
    });

  const updateOneSpy =
    overrides.updateOneSpy ??
    vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

  const mcpServerCollection = {
    findOne: findOneSpy,
    updateOne: updateOneSpy,
    find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    insertOne: vi.fn().mockResolvedValue({ insertedId: "srv-1" }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  } as unknown as RouteContext["mcpServerCollection"];

  const ctx = {
    app,
    registry,
    mcpServerCollection,
    mcpSecretClient: overrides.mcpSecretClient ?? null,
    // unused by PUT handler but required by RouteContext type
    db: {} as any,
    requestCollection: {} as any,
    runsCollection: {} as any,
    criteriaCollection: {} as any,
    promptFeatureCollection: {} as any,
    promptFeatureExtractionCollection: {} as any,
    reportCollection: {} as any,
    reportTemplateCollection: {} as any,
    agentCollection: {} as any,
    modelCollection: {} as any,
    insightsCollection: {} as any,
    taskPromptCollection: {} as any,
    featureFlagCollection: {} as any,
    skillCollection: {} as any,
    extensionCollection: {} as any,
    skillRevisionCollection: {} as any,
    profileCollection: {} as any,
    profileVersionCollection: {} as any,
    taskPromptStore: {} as any,
    skillRevisionStore: {} as any,
    skillResolver: {} as any,
    queueClients: new Map() as any,
    reportQueueClient: {} as any,
    getOrCreateQueueClient: vi.fn() as any,
    blobStorage: {} as any,
    validWorkers: [],
    storageConnectionString: "",
    storageAccountName: "",
  } as unknown as RouteContext;

  registerMcpServersRoutes(ctx);

  // Add generic error handler so unhandled throws surface as 500
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: err.message });
    },
  );

  return { app, ctx };
}

// ─── PUT /api/v1/mcp/servers/:id — secret reconciliation ────────────────────

describe("PUT /api/v1/mcp/servers/:id — secret reconciliation", () => {
  let listSecrets: ReturnType<typeof vi.fn>;
  let storeSecret: ReturnType<typeof vi.fn>;
  let deleteSecret: ReturnType<typeof vi.fn>;
  let mcpSecretClient: McpSecretClient;
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    listSecrets = vi.fn().mockResolvedValue([]);
    storeSecret = vi.fn().mockResolvedValue(makeListItem("k"));
    deleteSecret = vi.fn().mockResolvedValue(undefined);

    mcpSecretClient = { listSecrets, storeSecret, deleteSecret } as unknown as McpSecretClient;
    ({ app } = buildCtx({ mcpSecretClient }));
  });

  // ─── env: upsert ────────────────────────────────────────────────────────────

  it("upserts a real env value", async () => {
    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ env: { MY_KEY: "my-value" } });

    expect(res.status).toBe(200);
    expect(storeSecret).toHaveBeenCalledOnce();
    expect(storeSecret).toHaveBeenCalledWith("srv-1", "MY_KEY", "my-value");
  });

  // ─── env: preserve masked ────────────────────────────────────────────────────

  it('does NOT call storeSecret for env value equal to "<secret>"', async () => {
    listSecrets.mockResolvedValue([makeListItem("MY_KEY")]);

    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ env: { MY_KEY: "<secret>" } });

    expect(res.status).toBe(200);
    expect(storeSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  // ─── env: preserve empty ────────────────────────────────────────────────────

  it("does NOT call storeSecret for an empty env value", async () => {
    listSecrets.mockResolvedValue([makeListItem("MY_KEY")]);

    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ env: { MY_KEY: "" } });

    expect(res.status).toBe(200);
    expect(storeSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  // ─── env: delete omitted keys ────────────────────────────────────────────────

  it("deletes env secrets whose keys are absent from the submitted payload", async () => {
    listSecrets.mockResolvedValue([makeListItem("OLD_KEY"), makeListItem("KEEP_KEY")]);

    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ env: { KEEP_KEY: "<secret>" } }); // OLD_KEY omitted → delete

    expect(res.status).toBe(200);
    expect(deleteSecret).toHaveBeenCalledOnce();
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "OLD_KEY");
    expect(storeSecret).not.toHaveBeenCalled();
  });

  // ─── env: {} deletes all ────────────────────────────────────────────────────

  it("deletes all existing env secrets when env payload is {}", async () => {
    listSecrets.mockResolvedValue([makeListItem("A"), makeListItem("B")]);

    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ env: {} });

    expect(res.status).toBe(200);
    expect(deleteSecret).toHaveBeenCalledTimes(2);
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "A");
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "B");
    expect(storeSecret).not.toHaveBeenCalled();
  });

  // ─── headers: upsert ────────────────────────────────────────────────────────

  it("upserts a real header value", async () => {
    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ headers: [{ name: "X-Api-Key", value: "token123" }] });

    expect(res.status).toBe(200);
    expect(storeSecret).toHaveBeenCalledOnce();
    expect(storeSecret).toHaveBeenCalledWith("srv-1", "X-Api-Key", "token123");
  });

  // ─── headers: preserve masked ────────────────────────────────────────────────

  it('does NOT call storeSecret for header value equal to "<secret>"', async () => {
    listSecrets.mockResolvedValue([makeListItem("X-Api-Key")]);

    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ headers: [{ name: "X-Api-Key", value: "<secret>" }] });

    expect(res.status).toBe(200);
    expect(storeSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  // ─── headers: delete omitted ────────────────────────────────────────────────

  it("deletes header secrets whose names are absent from the submitted payload", async () => {
    listSecrets.mockResolvedValue([makeListItem("X-Old"), makeListItem("X-Keep")]);

    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ headers: [{ name: "X-Keep", value: "<secret>" }] }); // X-Old omitted → delete

    expect(res.status).toBe(200);
    expect(deleteSecret).toHaveBeenCalledOnce();
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "X-Old");
    expect(storeSecret).not.toHaveBeenCalled();
  });

  // ─── headers: [] deletes all ────────────────────────────────────────────────

  it("deletes all existing header secrets when headers payload is []", async () => {
    listSecrets.mockResolvedValue([makeListItem("X-Key-A"), makeListItem("X-Key-B")]);

    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ headers: [] });

    expect(res.status).toBe(200);
    expect(deleteSecret).toHaveBeenCalledTimes(2);
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "X-Key-A");
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "X-Key-B");
    expect(storeSecret).not.toHaveBeenCalled();
  });

  // ─── mutual exclusivity ─────────────────────────────────────────────────────

  it("returns 400 when both env and headers are present", async () => {
    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ env: { K: "v" }, headers: [{ name: "X-H", value: "h" }] });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(listSecrets).not.toHaveBeenCalled();
    expect(storeSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  // ─── no secret fields → no reconciliation ───────────────────────────────────

  it("does not call Token Manager when neither env nor headers are present", async () => {
    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(listSecrets).not.toHaveBeenCalled();
    expect(storeSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  // ─── 503 when secret client unavailable ─────────────────────────────────────

  it("returns 503 when env has real values but no secret client is configured", async () => {
    const { app: appNoClient } = buildCtx({ mcpSecretClient: null });

    const res = await request(appNoClient)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ env: { MY_KEY: "my-value" } });

    expect(res.status).toBe(503);
  });

  it("returns 503 when headers have real values but no secret client is configured", async () => {
    const { app: appNoClient } = buildCtx({ mcpSecretClient: null });

    const res = await request(appNoClient)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ headers: [{ name: "X-Key", value: "token" }] });

    expect(res.status).toBe(503);
  });

  // ─── listSecrets errors propagate ────────────────────────────────────────────

  it("propagates listSecrets errors instead of silently treating them as empty", async () => {
    listSecrets.mockRejectedValue(new Error("Token Manager unreachable"));

    const res = await request(app)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ env: { MY_KEY: "<secret>" } });

    // The error should propagate as a 500 (via the Express error handler)
    // rather than silently treating the secret list as empty.
    expect(res.status).toBe(500);
    expect(storeSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  // ─── 404 for unknown server ──────────────────────────────────────────────────

  it("returns 404 when the server does not exist", async () => {
    const findOneSpy = vi.fn().mockResolvedValue(null);
    const { app: appNotFound } = buildCtx({ mcpSecretClient, findOneSpy });

    const res = await request(appNotFound)
      .put("/api/v1/mcp/servers/missing")
      .send({ name: "Ghost" });

    expect(res.status).toBe(404);
  });

  // ─── type change across stdio boundary → delete all secrets ─────────────────

  it("deletes all secrets when type changes from stdio to http without secret fields", async () => {
    // Server is currently stdio type
    const findOneSpy = vi.fn()
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "stdio", createdAt: new Date() })
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "http", createdAt: new Date() });
    listSecrets.mockResolvedValue([makeListItem("ENV_KEY"), makeListItem("OTHER_KEY")]);
    const { app: appWithFind } = buildCtx({ mcpSecretClient, findOneSpy });

    const res = await request(appWithFind)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ type: "http", url: "https://example.com/mcp" });

    expect(res.status).toBe(200);
    expect(deleteSecret).toHaveBeenCalledTimes(2);
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "ENV_KEY");
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "OTHER_KEY");
    expect(storeSecret).not.toHaveBeenCalled();
  });

  it("deletes all secrets when type changes from http to stdio without secret fields", async () => {
    // Server is currently http type
    const findOneSpy = vi.fn()
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "http", createdAt: new Date() })
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "stdio", createdAt: new Date() });
    listSecrets.mockResolvedValue([makeListItem("X-Api-Key")]);
    const { app: appWithFind } = buildCtx({ mcpSecretClient, findOneSpy });

    const res = await request(appWithFind)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ type: "stdio", command: "npx my-server" });

    expect(res.status).toBe(200);
    expect(deleteSecret).toHaveBeenCalledOnce();
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "X-Api-Key");
    expect(storeSecret).not.toHaveBeenCalled();
  });

  it("does NOT delete secrets when type stays within the same kind (http → sse)", async () => {
    const findOneSpy = vi.fn()
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "http", createdAt: new Date() })
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "sse", createdAt: new Date() });
    listSecrets.mockResolvedValue([makeListItem("X-Api-Key")]);
    const { app: appWithFind } = buildCtx({ mcpSecretClient, findOneSpy });

    const res = await request(appWithFind)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ type: "sse", url: "https://example.com/sse" });

    expect(res.status).toBe(200);
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(storeSecret).not.toHaveBeenCalled();
  });

  it("does NOT delete secrets on type change when explicit secret reconciliation was also provided", async () => {
    // When the client sends both type and env/headers, explicit reconciliation handles secrets
    const findOneSpy = vi.fn()
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "stdio", createdAt: new Date() })
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "http", createdAt: new Date() });
    listSecrets.mockResolvedValue([makeListItem("OLD_KEY")]);
    const { app: appWithFind } = buildCtx({ mcpSecretClient, findOneSpy });

    const res = await request(appWithFind)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ type: "http", headers: [{ name: "X-New-Header", value: "token123" }] });

    expect(res.status).toBe(200);
    // Only the explicit reconciliation runs (deletes OLD_KEY, stores X-New-Header)
    expect(deleteSecret).toHaveBeenCalledOnce();
    expect(deleteSecret).toHaveBeenCalledWith("srv-1", "OLD_KEY");
    expect(storeSecret).toHaveBeenCalledOnce();
    expect(storeSecret).toHaveBeenCalledWith("srv-1", "X-New-Header", "token123");
  });

  it("propagates listSecrets error during type-change cleanup", async () => {
    const findOneSpy = vi.fn()
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "stdio", createdAt: new Date() })
      .mockResolvedValueOnce({ _id: "srv-1", name: "Test", type: "http", createdAt: new Date() });
    listSecrets.mockRejectedValue(new Error("Token Manager unreachable"));
    const { app: appWithFind } = buildCtx({ mcpSecretClient, findOneSpy });

    const res = await request(appWithFind)
      .put("/api/v1/mcp/servers/srv-1")
      .send({ type: "http", url: "https://example.com/mcp" });

    expect(res.status).toBe(500);
    expect(deleteSecret).not.toHaveBeenCalled();
  });
});
