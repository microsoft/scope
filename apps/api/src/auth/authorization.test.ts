// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { performance } from "node:perf_hooks";
import express from "express";
import request from "supertest";
import { MongoClient } from "mongodb";
import { UserDocumentSchema, type ProjectMembership } from "shared";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRoute } from "../openapi/api-route.js";
import { Authorization, protectStream, routePolicy } from "./authorization.js";
import { AccessError } from "./admin-operations.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Explicit HTTP route classification", () => {
  it("fails registration for unclassified endpoints", () => {
    expect(() => routePolicy("get", "/api/v1/unclassified")).toThrow("Unclassified API route");
  });
  it("keeps enrollment, control plane, metadata and project data distinct", () => {
    expect(routePolicy("post", "/api/v1/users/me")).toBe("self");
    expect(routePolicy("get", "/api/v1/admin/users")).toBe("platform");
    expect(routePolicy("get", "/api/v1/admin/users/search")).toBe("platform");
    expect(routePolicy("get", "/api/v1/admin/platform-admins")).toBe("platform");
    expect(routePolicy("post", "/api/v1/admin/users/:id/promote")).toBe("platform");
    expect(routePolicy("get", "/api/v1/agents")).toBe("metadata");
    expect(routePolicy("post", "/api/v1/agents")).toBe("platform");
    expect(routePolicy("get", "/api/v1/projects")).toBe("projects");
    expect(routePolicy("get", "/api/v1/resources/revisions/:id")).toBe("project");
  });
  it.each(["/reports", "/reports/bulk-create", "/reports/trigger", "/reports/bulk-trigger", "/reports/:id/insights"])(
    "blocks %s before any handler or enqueue operation", async path => {
      const app = express();
      const enqueue = vi.fn();
      apiRoute(app, new OpenAPIRegistry(), {
        method: "post", path: `/api/v1${path}`, tags: ["Reports"], summary: "Cutover fixture",
        response: z.unknown(), handler: (_req, res) => { enqueue(); res.json({}); },
      });
      app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error instanceof AccessError ? error.status : 500).json({ error: error.message });
      });
      expect((await request(app).post(`/api/v1${path.replace(":id", "fixture")}`).send({})).status).toBe(503);
      expect(enqueue).not.toHaveBeenCalled();
    });
  it("keeps stored-report reads and read-only bulk status available for project authorization", () => {
    expect(routePolicy("get", "/api/v1/reports/:id")).toBe("project");
    expect(routePolicy("post", "/api/v1/reports/bulk-status")).toBe("project");
    expect(routePolicy("post", "/api/v1/reports/bulk-summary")).toBe("project");
  });
  it("fails closed before controller execution when authorization has not initialized", async () => {
    const app = express();
    const controller = vi.fn();
    apiRoute(app, new OpenAPIRegistry(), {
      method: "get", path: "/api/v1/criteria", tags: ["Criteria"], summary: "Unavailable authority",
      response: z.unknown(), handler: (_req, res) => { controller(); res.json([]); },
    });
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error instanceof AccessError ? error.status : 500).json({ error: error.message });
    });
    expect((await request(app).get("/api/v1/criteria")).status).toBe(503);
    expect(controller).not.toHaveBeenCalled();
  });
});

describe("Canonical authority work budget", () => {
  describe("Project membership administration", () => {
    function fixture(role: "reader" | "contributor" | "admin", platformAdmin = false) {
      const authority = new Authorization(new MongoClient("mongodb://127.0.0.1:1").db("unused_unit_fixture"));
      vi.spyOn(authority, "currentUser").mockResolvedValue(UserDocumentSchema.parse({
        _id: "actor", role: platformAdmin ? "admin" : "user", idp: "entra", idpTenant: "fixture", idpSubject: "fixture",
        createdAt: new Date(), updatedAt: new Date(),
      }));
      const membership: ProjectMembership = {
        _id: "a:actor", projectId: "a", userId: "actor", role, revision: 1,
        createdAt: new Date(), updatedAt: new Date(), createdByUserId: "operator",
        lastOperationId: "grant", appliedOperationIds: ["grant"],
      };
      const memberships = vi.spyOn(authority, "memberships").mockResolvedValue([membership]);
      const req = Object.assign(Object.create(express.request) as express.Request, {
        params: { id: "a", userId: "target" }, query: {}, body: {},
        auth: { token: `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url")}.signature` },
      });
      return { authority, memberships, membership, req };
    }
    it.each(["get", "put", "delete"])("allows a current project admin to %s only their own membership surface", async method => {
      const { authority, req } = fixture("admin");
      const path = `/api/v1/projects/:id/members${method === "get" ? "" : "/:userId"}`;
      await expect(authority.guard(req, method, path, "projects")).resolves.toBeTypeOf("number");
      req.params.id = "b";
      await expect(authority.guard(req, method, path, "projects")).rejects.toMatchObject({ status: 404 });
    });
    it.each(["reader", "contributor"] as const)("denies the in-project %s roster, search, lookup and mutation", async role => {
      const { authority, req } = fixture(role);
      for (const [method, suffix] of [["get", ""], ["get", "/search"], ["get", "/lookup/:userId"], ["put", "/:userId"], ["delete", "/:userId"]]) {
        await expect(authority.guard(req, method, `/api/v1/projects/:id/members${suffix}`, "projects"))
          .rejects.toMatchObject({ status: 403 });
      }
    });
    it("rereads membership on the next request after demotion or removal", async () => {
      const { authority, req, membership, memberships } = fixture("admin");
      const path = "/api/v1/projects/:id/members";
      await expect(authority.guard(req, "get", path, "projects")).resolves.toBeTypeOf("number");
      memberships.mockResolvedValue([{ ...membership, role: "reader" }]);
      await expect(authority.guard(req, "get", path, "projects")).rejects.toMatchObject({ status: 403 });
      memberships.mockResolvedValue([]);
      await expect(authority.guard(req, "get", path, "projects")).rejects.toMatchObject({ status: 404 });
    });
    it("does not grant project admins directory, inventory, lifecycle or global platform powers", async () => {
      const { authority, req } = fixture("admin");
      for (const path of ["/api/v1/admin/users/search", "/api/v1/admin/users", "/api/v1/admin/users/:id/promote", "/api/v1/keys", "/api/v1/accounts"]) {
        await expect(authority.guard(req, "get", path, "platform")).rejects.toMatchObject({ status: 403 });
      }
      req.query.controlPlane = "true";
      await expect(authority.guard(req, "get", "/api/v1/projects", "projects")).rejects.toMatchObject({ status: 403 });
      for (const [method, path] of [["post", "/api/v1/projects"], ["delete", "/api/v1/projects/:id"], ["post", "/api/v1/projects/:id/restore"]]) {
        await expect(authority.guard(req, method, path, "projects")).rejects.toMatchObject({ status: 403 });
      }
    });
    it("retains platform administration without project membership", async () => {
      const { authority, req, memberships } = fixture("reader", true);
      memberships.mockResolvedValue([]);
      for (const method of ["get", "put", "delete"]) {
        await expect(authority.guard(req, method, "/api/v1/projects/:id/members/:userId", "projects")).resolves.toBeTypeOf("number");
      }
      expect(memberships).not.toHaveBeenCalled();
    });
  });
  it("passes one original deadline through identity and membership reads", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const authority = new Authorization(new MongoClient("mongodb://127.0.0.1:1").db("unused_unit_fixture"));
    const user = UserDocumentSchema.parse({
      _id: "fixture-user", idp: "entra", idpTenant: "fixture", idpSubject: "fixture",
      createdAt: new Date(), updatedAt: new Date(),
    });
    vi.spyOn(authority, "currentUser").mockImplementation(async (_req, deadline) => {
      expect(deadline).toBe(20_000);
      now = 19_000;
      return user;
    });
    vi.spyOn(authority, "memberships").mockImplementation(async (_userId, deadline) => {
      expect(deadline).toBe(20_000);
      now = 20_001;
      return [];
    });
    await expect(authority.capabilities(express.request)).rejects.toMatchObject({ code: "authority_timeout" });
  });

  describe("Explicit authentication opt-out", () => {
    const authority = () => new Authorization(new MongoClient("mongodb://127.0.0.1:1").db("unused_unit_fixture"), false);

    it.each(["/api/v1/admin/users", "/api/v1/admin/platform-admins", "/api/v1/admin/users/:id/promote",
      "/api/v1/projects/:id/members", "/api/v1/projects/:id/members/:userId"])(
      "does not open identity or membership administration at %s", async path => {
        await expect(authority().guard(express.request, "get", path, routePolicy("get", path)))
          .rejects.toMatchObject({ code: "authentication_disabled" });
      },
    );
    it.each(["/api/v1/projects", "/api/v1/agents", "/api/v1/models", "/api/v1/feature-flags"])(
      "allows legacy application access at %s without reading users or memberships", async path => {
        const auth = authority();
        const current = vi.spyOn(auth, "currentUser");
        const memberships = vi.spyOn(auth, "memberships");
        await expect(auth.guard(express.request, "get", path, routePolicy("get", path))).resolves.toBeTypeOf("number");
        expect(current).not.toHaveBeenCalled();
        expect(memberships).not.toHaveBeenCalled();
      },
    );
    it("does not enable report producers when auth is disabled", async () => {
      await expect(authority().guard(express.request, "post", "/api/v1/reports", "disabled"))
        .rejects.toMatchObject({ code: "report_generation_disabled" });
    });
  });

  it("does not start a new membership query after its deadline expires", async () => {
    vi.spyOn(performance, "now").mockReturnValue(20_001);
    const authority = new Authorization(new MongoClient("mongodb://127.0.0.1:1").db("unused_unit_fixture"));
    await expect(authority.memberships("fixture-user", 20_000)).rejects.toMatchObject({ code: "authority_timeout" });
  });
});

describe("Open stream freshness leases", () => {
  it("closes at the original deadline during a hung authority read and refuses subsequent writes", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const originalWrite = vi.fn(() => true);
    const res: Parameters<typeof protectStream>[0] = { write: originalWrite, end: vi.fn(), once: vi.fn() };
    protectStream(res, () => new Promise<number>(() => {}), 20000);
    now = 19999;
    await vi.advanceTimersByTimeAsync(19000);
    expect(res.end).not.toHaveBeenCalled();
    now = 20000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.end).toHaveBeenCalled();
    expect(res.write("not permitted")).toBe(false);
    expect(originalWrite).not.toHaveBeenCalled();
  });
  it("closes on the first denied authority recheck rather than retaining a warm grant", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const res: Parameters<typeof protectStream>[0] = { write: vi.fn(() => true), end: vi.fn(), once: vi.fn() };
    protectStream(res, async () => { throw new AccessError(404, "not_found", "Not found"); }, 20000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.end).toHaveBeenCalledOnce();
    expect(res.write("forbidden")).toBe(false);
  });
  it("never outlives the token-capped initial deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(2000);
    const res: Parameters<typeof protectStream>[0] = { write: vi.fn(() => true), end: vi.fn(), once: vi.fn() };
    protectStream(res, async () => 1000, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.end).toHaveBeenCalled();
  });
  it("cannot be revived by a successful authority result arriving after closure", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let complete: ((deadline: number) => void) | undefined;
    const res: Parameters<typeof protectStream>[0] = { write: vi.fn(() => true), end: vi.fn(), once: vi.fn() };
    protectStream(res, () => new Promise<number>(resolve => { complete = resolve; }), 20_000);
    await vi.advanceTimersByTimeAsync(1000);
    now = 20_000;
    await vi.advanceTimersByTimeAsync(19_000);
    expect(res.end).toHaveBeenCalledOnce();
    if (!complete) throw new Error("Expected an in-flight authority recheck");
    complete(60_000);
    await Promise.resolve();
    expect(res.write("late result must not grant access")).toBe(false);
    expect(res.end).toHaveBeenCalledOnce();
  });
});
