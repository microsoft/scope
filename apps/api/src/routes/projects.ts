// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ProjectResponseSchema,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import { Authorization } from "../auth/authorization.js";
import { operationId } from "./access.js";
import { createHash } from "node:crypto";

/**
 * Projects CRUD.
 *
 * A project is the top-level, **unscoped** container. It has no `projectId`
 * itself. Delete is a **soft-delete**: it is always allowed (even when the
 * project still owns scoped data), because it is fully reversible via
 * `POST /projects/:id/restore`. Soft-deleting a non-empty project simply hides
 * it and its data from the default listings; restoring brings everything back.
 */
export function registerProjectsRoutes(ctx: RouteContext): void {
  const authority = () => new Authorization(ctx.db, ctx.authEnabled);
  // List all projects (newest first). Pass `?includeDeleted=true` to also return
  // soft-deleted projects (so the Portal/CLI can offer a restore affordance).
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/projects",
    tags: ["Projects"],
    summary: "List all projects",
    query: z.object({
      includeDeleted: z
        .enum(["true", "false"])
        .optional()
        .describe("When true, include soft-deleted projects in the result"),
      controlPlane: z.enum(["true", "false"]).optional(),
    }),
    response: z.array(ProjectResponseSchema),
    handler: async (req, res, next) => {
      try {
        const includeDeleted = req.query.includeDeleted === "true";
        const projects = await ctx.projectStore.list({ includeDeleted });
        const memberships = ctx.authEnabled === false ? [] : await authority().memberships(req.user!.id);
        const visible = ctx.authEnabled === false || req.query.controlPlane === "true" ? projects : projects.filter(p => memberships.some(m => m.projectId === p._id));
        res.json(visible.map((p) => ({ ...p, id: p._id })));
      } catch (error) {
        next(error);
      }
    },
  });

  // Create a project.
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/projects",
    tags: ["Projects"],
    summary: "Create a project",
    body: CreateProjectInputSchema.strict(),
    response: ProjectResponseSchema,
    successStatus: 201,
    errorResponses: { 400: { description: "Invalid input" } },
    handler: async (req, res, next) => {
      try {
        const id = operationId(req);
        const hash = createHash("sha256").update(`project:${id}`).digest("hex");
        const projectId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const result = await authority().operations.execute({
          _id: id, actor: req.user!.id, reason: ctx.authEnabled === false ? "Anonymous project creation (authentication disabled)" : "Platform-admin project creation",
          collection: "projects", targetId: projectId, expectedRevision: 0,
          change: { name: req.body.name, ...(req.body.description !== undefined ? { description: req.body.description } : {}) },
          unset: [], initial: {},
          ...(ctx.authEnabled === false ? {} : { creatorMembershipOperationId: `project-creator:${hash}` }),
        });
        if (result.state === "pending") { res.status(202).json(result); return; }
        const project = await ctx.projectStore.get(projectId);
        res.status(201).json({ ...project, id: projectId, operationId: result.operationId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/name is required/i.test(message)) {
          res.status(400).json({ error: message });
          return;
        }
        next(error);
      }
    },
  });

  // Get a project by id.
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/projects/:id",
    tags: ["Projects"],
    summary: "Get a project",
    response: ProjectResponseSchema,
    errorResponses: { 404: { description: "Project not found" } },
    handler: async (req, res, next) => {
      try {
        const project = await ctx.projectStore.get(req.params.id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json({ ...project, id: project._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Patch a project (rename / describe).
  apiRoute(ctx.app, ctx.registry, {
    method: "patch",
    path: "/api/v1/projects/:id",
    tags: ["Projects"],
    summary: "Update a project",
    body: UpdateProjectInputSchema.extend({ revision: z.number().int().nonnegative() }).strict(),
    response: ProjectResponseSchema,
    errorResponses: { 404: { description: "Project not found" } },
    handler: async (req, res, next) => {
      try {
        const result = await authority().operations.execute({
          _id: operationId(req), actor: req.user!.id, reason: ctx.authEnabled === false ? "Anonymous project settings update (authentication disabled)" : "Project settings update",
          collection: "projects", targetId: req.params.id, expectedRevision: req.body.revision,
          change: { ...(req.body.name !== undefined ? { name: req.body.name } : {}), ...(req.body.description !== undefined ? { description: req.body.description } : {}) },
          unset: [], condition: { deletedAt: { $exists: false } },
        });
        if (result.state === "pending") { res.status(202).json(result); return; }
        const updated = await ctx.projectStore.get(req.params.id);
        if (!updated) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json({ ...updated, id: updated._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Soft-delete a project. Always allowed (even when non-empty) because it is
  // reversible via POST /projects/:id/restore.
  apiRoute(ctx.app, ctx.registry, {
    method: "delete",
    path: "/api/v1/projects/:id",
    tags: ["Projects"],
    summary: "Soft-delete a project",
    body: z.object({ revision: z.number().int().nonnegative() }).strict(),
    response: z.any(),
    rawResponse: true,
    successStatus: 204,
    errorResponses: {
      404: { description: "Project not found" },
    },
    handler: async (req, res, next) => {
      try {
        const result = await authority().operations.execute({
          _id: operationId(req), actor: req.user!.id, reason: ctx.authEnabled === false ? "Anonymous project deletion (authentication disabled)" : "Platform-admin project deletion",
          collection: "projects", targetId: req.params.id, expectedRevision: req.body.revision,
          change: { deletedAt: "$operationTime" }, unset: [],
        });
        if (result.state === "pending") { res.status(202).json(result); return; }
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  });

  // Restore a soft-deleted project (clears `deletedAt`). Restoring a project
  // that is not deleted is a no-op that returns it unchanged.
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/projects/:id/restore",
    tags: ["Projects"],
    summary: "Restore a soft-deleted project",
    body: z.object({ revision: z.number().int().nonnegative() }).strict(),
    response: ProjectResponseSchema,
    errorResponses: { 404: { description: "Project not found" } },
    handler: async (req, res, next) => {
      try {
        const existing = await ctx.projectStore.get(req.params.id, { includeDeleted: true });
        if (!existing) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        const result = await authority().operations.execute({
          _id: operationId(req), actor: req.user!.id, reason: ctx.authEnabled === false ? "Anonymous project restoration (authentication disabled)" : "Platform-admin project restoration",
          collection: "projects", targetId: req.params.id, expectedRevision: req.body.revision,
          change: {}, unset: ["deletedAt"],
        });
        if (result.state === "pending") { res.status(202).json(result); return; }
        const restored = await ctx.projectStore.get(req.params.id);
        if (!restored) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json({ ...restored, id: restored._id });
      } catch (error) {
        next(error);
      }
    },
  });
}
