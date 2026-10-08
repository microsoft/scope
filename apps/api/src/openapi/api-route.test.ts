// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import express from "express";
import request from "supertest";
import { apiRoute, toOpenApiPath } from "./api-route.js";

extendZodWithOpenApi(z);

// ─── toOpenApiPath ───────────────────────────────────────────────────────────

describe("toOpenApiPath", () => {
  it("converts :param to {param}", () => {
    expect(toOpenApiPath("/api/v1/criteria/:id")).toBe("/api/v1/criteria/{id}");
  });

  it("converts multiple params", () => {
    expect(toOpenApiPath("/api/v1/:resource/:id/sub/:subId")).toBe(
      "/api/v1/{resource}/{id}/sub/{subId}",
    );
  });

  it("leaves paths without params unchanged", () => {
    expect(toOpenApiPath("/api/v1/criteria")).toBe("/api/v1/criteria");
  });

  it("handles root path", () => {
    expect(toOpenApiPath("/")).toBe("/");
  });
});

// ─── apiRoute — OpenAPI registration ─────────────────────────────────────────

describe("apiRoute — OpenAPI registration", () => {
  let app: express.Express;
  let registry: OpenAPIRegistry;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    registry = new OpenAPIRegistry();
  });

  it("registers a simple GET route", () => {
    const ResponseSchema = z.object({ items: z.array(z.string()) }).openapi("TestResponse");

    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/items",
      tags: ["Items"],
      summary: "List items",
      response: ResponseSchema,
      handler: async (_req, res) => {
        res.json({ items: [] });
      },
    });

    const doc = generateDoc(registry);
    expect(doc.paths?.["/api/v1/items"]?.get).toBeDefined();
    expect(doc.paths?.["/api/v1/items"]?.get?.tags).toEqual(["Items"]);
    expect(doc.paths?.["/api/v1/items"]?.get?.summary).toBe("List items");
    expect(doc.paths?.["/api/v1/items"]?.get).not.toHaveProperty("security");
    expect(doc).not.toHaveProperty("security");
  });

  it.each([
    { name: "bearer authentication", security: [{ bearerAuth: [] }] },
    { name: "an explicit anonymous override", security: [] },
  ])("forwards $name as operation-scoped documentation only", async ({ security }) => {
    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/security-docs",
      tags: ["Test"],
      summary: "Security documentation",
      security,
      response: z.object({ ok: z.boolean() }),
      handler: (_req, res) => {
        res.json({ ok: true });
      },
    });

    const doc = generateDoc(registry);
    expect(doc.paths?.["/api/v1/security-docs"]?.get?.security).toEqual(security);
    expect(doc).not.toHaveProperty("security");
    expect((await request(app).get("/api/v1/security-docs")).status).toBe(200);
  });

  it("registers path params in OpenAPI format", () => {
    const ResponseSchema = z.object({ id: z.string() }).openapi("ItemResponse");

    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/items/:id",
      tags: ["Items"],
      summary: "Get item",
      params: z.object({ id: z.string() }),
      response: ResponseSchema,
      handler: async (_req, res) => {
        res.json({ id: "1" });
      },
    });

    const doc = generateDoc(registry);
    // Path should use {id} format
    expect(doc.paths?.["/api/v1/items/{id}"]?.get).toBeDefined();
    // Should not have Express-style :id
    expect(doc.paths?.["/api/v1/items/:id"]).toBeUndefined();
  });

  it("registers body, query, and params schemas", () => {
    const BodySchema = z.object({ name: z.string() }).openapi("CreateItem");
    const QuerySchema = z.object({ verbose: z.string().optional() }).openapi("CreateQuery");
    const ParamsSchema = z.object({ group: z.string() });
    const ResponseSchema = z.object({ id: z.string() }).openapi("CreateResponse");

    apiRoute(app, registry, {
      method: "post",
      path: "/api/v1/groups/:group/items",
      tags: ["Items"],
      summary: "Create item in group",
      body: BodySchema,
      query: QuerySchema,
      params: ParamsSchema,
      response: ResponseSchema,
      handler: async (_req, res) => {
        res.status(201).json({ id: "1" });
      },
    });

    const doc = generateDoc(registry);
    const route = doc.paths?.["/api/v1/groups/{group}/items"]?.post;
    expect(route).toBeDefined();
    // Should have request body
    expect(route?.requestBody).toBeDefined();
    // Should have parameters (group path param + verbose query param)
    expect(route?.parameters).toBeDefined();
    expect(route?.parameters!.length).toBeGreaterThanOrEqual(1);
  });

  it("uses 201 status for POST by default", () => {
    const ResponseSchema = z.object({ id: z.string() }).openapi("Created");

    apiRoute(app, registry, {
      method: "post",
      path: "/api/v1/items",
      tags: ["Items"],
      summary: "Create item",
      body: z.object({ name: z.string() }).openapi("CreateInput"),
      response: ResponseSchema,
      handler: async (_req, res) => {
        res.status(201).json({ id: "1" });
      },
    });

    const doc = generateDoc(registry);
    const route = doc.paths?.["/api/v1/items"]?.post;
    expect(route?.responses?.["201"]).toBeDefined();
    expect(route?.responses?.["200"]).toBeUndefined();
  });

  it("uses 200 status for GET by default", () => {
    const ResponseSchema = z.object({ ok: z.boolean() }).openapi("GetResp");

    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/status",
      tags: ["Status"],
      summary: "Get status",
      response: ResponseSchema,
      handler: async (_req, res) => {
        res.json({ ok: true });
      },
    });

    const doc = generateDoc(registry);
    const route = doc.paths?.["/api/v1/status"]?.get;
    expect(route?.responses?.["200"]).toBeDefined();
  });

  it("allows custom successStatus", () => {
    const ResponseSchema = z.object({}).openapi("NoContent");

    apiRoute(app, registry, {
      method: "delete",
      path: "/api/v1/items/:id",
      tags: ["Items"],
      summary: "Delete item",
      params: z.object({ id: z.string() }),
      response: ResponseSchema,
      successStatus: 204,
      handler: async (_req, res) => {
        res.sendStatus(204);
      },
    });

    const doc = generateDoc(registry);
    const route = doc.paths?.["/api/v1/items/{id}"]?.delete;
    expect(route?.responses?.["204"]).toBeDefined();
  });

  it("registers rawResponse routes without JSON content", () => {
    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/items/:id/stream",
      tags: ["Items"],
      summary: "Stream item logs",
      params: z.object({ id: z.string() }),
      response: z.any(),
      rawResponse: true,
      responseDescription: "Server-sent event stream",
      handler: async (_req, res) => {
        res.end();
      },
    });

    const doc = generateDoc(registry);
    const route = doc.paths?.["/api/v1/items/{id}/stream"]?.get;
    expect(route?.responses?.["200"]).toBeDefined();
    // rawResponse should NOT have content
    const resp = route?.responses?.["200"] as Record<string, unknown>;
    expect(resp.content).toBeUndefined();
    expect(resp.description).toBe("Server-sent event stream");
  });

  it("registers errorResponses with description only", () => {
    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/items/:id",
      tags: ["Items"],
      summary: "Get item",
      params: z.object({ id: z.string() }),
      response: z.object({ id: z.string() }),
      errorResponses: {
        404: { description: "Item not found" },
      },
      handler: async (_req, res) => {
        res.json({ id: "1" });
      },
    });

    const doc = generateDoc(registry);
    const route = doc.paths?.["/api/v1/items/{id}"]?.get;
    expect(route?.responses?.["200"]).toBeDefined();
    expect(route?.responses?.["404"]).toBeDefined();
    const r404 = route?.responses?.["404"] as Record<string, unknown>;
    expect(r404.description).toBe("Item not found");
    expect(r404.content).toBeUndefined();
  });

  it("registers errorResponses with schema", () => {
    apiRoute(app, registry, {
      method: "post",
      path: "/api/v1/generate",
      tags: ["AI"],
      summary: "Generate content",
      body: z.object({ prompt: z.string() }),
      response: z.object({ text: z.string() }),
      errorResponses: {
        503: {
          description: "LLM unavailable",
          schema: z.object({ error: z.string() }),
        },
      },
      handler: async (_req, res) => {
        res.json({ text: "ok" });
      },
    });

    const doc = generateDoc(registry);
    const route = doc.paths?.["/api/v1/generate"]?.post;
    expect(route?.responses?.["201"]).toBeDefined();
    expect(route?.responses?.["503"]).toBeDefined();
    const r503 = route?.responses?.["503"] as Record<string, unknown>;
    expect(r503.description).toBe("LLM unavailable");
    expect(r503.content).toBeDefined();
  });

  it("registers multiple errorResponses", () => {
    apiRoute(app, registry, {
      method: "delete",
      path: "/api/v1/resources/:id",
      tags: ["Resources"],
      summary: "Delete resource",
      params: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
      errorResponses: {
        404: { description: "Resource not found" },
        409: { description: "Resource in use", schema: z.object({ error: z.string() }) },
      },
      handler: async (_req, res) => {
        res.json({ deleted: true });
      },
    });

    const doc = generateDoc(registry);
    const route = doc.paths?.["/api/v1/resources/{id}"]?.delete;
    expect(route?.responses?.["200"]).toBeDefined();
    expect(route?.responses?.["404"]).toBeDefined();
    expect(route?.responses?.["409"]).toBeDefined();
  });
});

// ─── apiRoute — Express handler + validation ─────────────────────────────────

describe("apiRoute — Express handler + validation", () => {
  let app: express.Express;
  let registry: OpenAPIRegistry;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    registry = new OpenAPIRegistry();
  });

  it("calls handler for valid requests", async () => {
    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/items",
      tags: ["Items"],
      summary: "List items",
      response: z.array(z.string()),
      handler: async (_req, res) => {
        res.json(["a", "b"]);
      },
    });

    const resp = await request(app).get("/api/v1/items");
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(["a", "b"]);
  });

  it("validates body and returns 400 on failure", async () => {
    const BodySchema = z.object({
      name: z.string(),
      count: z.number().min(1),
    });

    apiRoute(app, registry, {
      method: "post",
      path: "/api/v1/items",
      tags: ["Items"],
      summary: "Create item",
      body: BodySchema,
      response: z.object({ id: z.string() }),
      handler: async (_req, res) => {
        res.status(201).json({ id: "1" });
      },
    });

    // Missing required field
    const resp = await request(app)
      .post("/api/v1/items")
      .send({ count: 5 });

    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe("Validation failed");
    expect(resp.body.details).toBeDefined();
    expect(resp.body.details.length).toBeGreaterThan(0);
    expect(resp.body.details[0].path).toBe("name");
  });

  it("validates query params and returns 400 on failure", async () => {
    const QuerySchema = z.object({
      page: z.coerce.number().min(1),
    });

    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/items",
      tags: ["Items"],
      summary: "List items",
      query: QuerySchema,
      response: z.array(z.string()),
      handler: async (_req, res) => {
        res.json([]);
      },
    });

    const resp = await request(app).get("/api/v1/items?page=0");
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe("Validation failed");
  });

  it("validates path params and returns 400 on failure", async () => {
    const ParamsSchema = z.object({
      id: z.string().uuid(),
    });

    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/items/:id",
      tags: ["Items"],
      summary: "Get item",
      params: ParamsSchema,
      response: z.object({ id: z.string() }),
      handler: async (req, res) => {
        res.json({ id: req.params.id });
      },
    });

    const resp = await request(app).get("/api/v1/items/not-a-uuid");
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe("Validation failed");
    expect(resp.body.details[0].path).toBe("id");
  });

  it("passes validated body to handler", async () => {
    const BodySchema = z.object({
      name: z.string(),
      count: z.number().default(1),
    });

    apiRoute(app, registry, {
      method: "post",
      path: "/api/v1/items",
      tags: ["Items"],
      summary: "Create item",
      body: BodySchema,
      response: z.object({ name: z.string(), count: z.number() }),
      handler: async (req, res) => {
        // count should be 1 (Zod default), not undefined
        res.status(201).json({ name: req.body.name, count: req.body.count });
      },
    });

    const resp = await request(app)
      .post("/api/v1/items")
      .send({ name: "test" });

    expect(resp.status).toBe(201);
    expect(resp.body).toEqual({ name: "test", count: 1 });
  });

  it("passes validated query to handler", async () => {
    const QuerySchema = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(10),
    });

    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/items",
      tags: ["Items"],
      summary: "List items",
      query: QuerySchema,
      response: z.object({ page: z.number(), limit: z.number() }),
      handler: async (req, res) => {
        res.json({ page: req.query.page, limit: req.query.limit });
      },
    });

    const resp = await request(app).get("/api/v1/items");
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ page: 1, limit: 10 });
  });

  it("passes validated params to handler", async () => {
    const ParamsSchema = z.object({ id: z.string() });

    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/items/:id",
      tags: ["Items"],
      summary: "Get item",
      params: ParamsSchema,
      response: z.object({ id: z.string() }),
      handler: async (req, res) => {
        res.json({ id: req.params.id });
      },
    });

    const resp = await request(app).get("/api/v1/items/abc-123");
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ id: "abc-123" });
  });

  it("catches errors thrown in handler and calls next()", async () => {
    apiRoute(app, registry, {
      method: "get",
      path: "/api/v1/fail",
      tags: ["Test"],
      summary: "Fail route",
      response: z.any(),
      handler: async () => {
        throw new Error("handler boom");
      },
    });

    // Add error handler (like the real app)
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const resp = await request(app).get("/api/v1/fail");
    expect(resp.status).toBe(500);
    expect(resp.body.error).toBe("handler boom");
  });

  it("allows valid body to pass through", async () => {
    const BodySchema = z.object({
      enabled: z.boolean(),
    });

    apiRoute(app, registry, {
      method: "put",
      path: "/api/v1/flags/:key",
      tags: ["Flags"],
      summary: "Update flag",
      params: z.object({ key: z.string() }),
      body: BodySchema,
      response: z.object({ key: z.string(), enabled: z.boolean() }),
      handler: async (req, res) => {
        res.json({ key: req.params.key, enabled: req.body.enabled });
      },
    });

    const resp = await request(app)
      .put("/api/v1/flags/dark-mode")
      .send({ enabled: true });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ key: "dark-mode", enabled: true });
  });
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function generateDoc(registry: OpenAPIRegistry) {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: { title: "Test", version: "0.0.0" },
  });
}
