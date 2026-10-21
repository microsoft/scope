// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { UserDocument } from "shared";
import {
  AccessUserSearchResultSchema, AccessUserSummarySchema, ProjectMembershipSummarySchema, ProjectRoleSchema,
  PlatformAdminListSchema, PlatformAdminPromotionSchema,
  type AccessUserSummary, type PlatformAdminSummary, type ProjectMembership, type ProjectMembershipSummary,
} from "shared/rbac";
import type { Filter } from "mongodb";
import type { RouteContext } from "../route-context.js";
import { apiRoute } from "../openapi/api-route.js";
import { Authorization } from "../auth/authorization.js";
import { AccessError, type AdminOperation } from "../auth/admin-operations.js";
import type { Request } from "express";

export function operationId(req: Request): string {
  const id = req.get("Idempotency-Key") ?? randomUUID();
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id)) throw new AccessError(400, "invalid_operation_id", "Invalid Idempotency-Key");
  req.res?.setHeader("X-Operation-Id", id);
  return id;
}

const membershipInput = z.object({
  role: ProjectRoleSchema,
  revision: z.number().int().nonnegative(),
}).strict();
const revisionInput = z.object({ revision: z.number().int().nonnegative() }).strict();
const userSearchQuery = z.object({
  q: z.string().trim().max(100).default(""),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const userProjection = { _id: 1, displayName: 1, email: 1, alias: 1, role: 1, disabledAt: 1, revision: 1 };

function userSummary(user: UserDocument): AccessUserSummary {
  return {
    id: user._id, displayName: user.displayName, email: user.email, alias: user.alias,
    role: user.role, disabled: Boolean(user.disabledAt), revision: user.revision ?? 0,
  };
}

export function registerAccessRoutes(ctx: Pick<RouteContext, "app" | "registry" | "db" | "usersCollection" | "projectStore">): void {
  const auth = () => new Authorization(ctx.db);
  const searchUsers = async ({ q, cursor, limit }: z.infer<typeof userSearchQuery>) => {
    const literal = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter: Filter<UserDocument> = {
      ...(cursor ? { _id: { $gt: cursor } } : {}),
      ...(literal ? { $or: ["displayName", "email", "alias", "_id"].map(field => ({ [field]: { $regex: literal, $options: "i" } })) } : {}),
    };
    const users = await ctx.usersCollection.find(filter, { projection: userProjection, timeoutMS: 5_000 })
      .sort({ _id: 1 }).limit(limit + 1).toArray();
    const page = users.slice(0, limit);
    return {
      items: page.map(userSummary),
      ...(users.length > limit ? { nextCursor: page[page.length - 1]._id } : {}),
    };
  };
  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: "/api/v1/admin/platform-admins", tags: ["Access"], summary: "List platform administrators, including disabled accounts and pending changes",
    query: z.object({
      cursor: z.string().min(1).max(200).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }).strict(),
    response: PlatformAdminListSchema,
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const { cursor, limit } = req.query;
      const users = await ctx.usersCollection.find({
        role: "admin", ...(cursor ? { _id: { $gt: cursor } } : {}),
      }, { projection: { ...userProjection, lastOperationId: 1 }, timeoutMS: 5_000 })
        .sort({ _id: 1 }).limit(limit + 1).toArray();
      const page = users.slice(0, limit);
      const markers = page.flatMap(user => user.lastOperationId ? [user.lastOperationId] : []);
      const operations = markers.length ? await ctx.db.collection<AdminOperation>("admin_operations")
        .find({ _id: { $in: markers }, state: "completed" }, { projection: { _id: 1 }, timeoutMS: 5_000 }).toArray() : [];
      const completed = new Set(operations.map(operation => operation._id));
      const items: PlatformAdminSummary[] = page.map(user => ({
        ...userSummary(user), role: "admin",
        pending: user.lastOperationId !== undefined && !completed.has(user.lastOperationId),
        operationId: user.lastOperationId,
      }));
      res.json({ items, ...(users.length > limit ? { nextCursor: page[page.length - 1]._id } : {}) });
    },
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "post", path: "/api/v1/admin/users/:id/promote", tags: ["Access"], summary: "Promote an enabled enrolled user to platform administrator",
    body: PlatformAdminPromotionSchema, response: z.object({
      operationId: z.string(), state: z.enum(["completed", "pending"]), revision: z.number().int().positive(),
    }),
    successStatus: 200,
    errorResponses: {
      202: { description: "Promotion is pending; retry identical input or ask an operator to inspect/repair the same operation ID before claiming completion" },
      404: { description: "Enrolled user not found" },
      409: { description: "Revision, role, enabled state or idempotency precondition conflict" },
    },
    handler: async (req, res) => {
      const id = operationId(req);
      const user = await ctx.usersCollection.findOne({ _id: req.params.id }, { timeoutMS: 5_000 });
      if (!user) throw new AccessError(404, "not_found", "Enrolled user not found");
      const authority = auth();
      if (user.lastOperationId && user.lastOperationId !== id && !await authority.operations.isComplete(user.lastOperationId)) {
        throw new AccessError(409, "operation_pending", `User access change ${user.lastOperationId} requires identical retry or operator repair before promotion`);
      }
      const result = await authority.operations.execute({
        _id: id, actor: req.user!.id, reason: "Explicit platform-admin promotion of an enrolled user",
        collection: "users", targetId: user._id, expectedRevision: req.body.revision,
        change: { role: "admin" }, unset: [],
        condition: { role: "user", disabledAt: { $exists: false } },
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(result.state === "pending" ? 202 : 200).json(result);
    },
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: "/api/v1/admin/users/search", tags: ["Access"], summary: "Search enrolled platform users (platform administration)",
    query: userSearchQuery,
    response: AccessUserSearchResultSchema,
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await searchUsers(req.query));
    },
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: "/api/v1/projects/:id/members/search", tags: ["Access"], summary: "Search enrolled users to add to this project (project or platform administration)",
    params: z.object({ id: z.string().min(1) }).strict(),
    query: userSearchQuery,
    response: AccessUserSearchResultSchema,
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await searchUsers(req.query));
    },
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: "/api/v1/admin/users", tags: ["Access"], summary: "Look up an exactly identified enrolled user",
    query: z.object({ userId: z.string().optional(), idp: z.string().optional(), tenant: z.string().optional(), subject: z.string().optional() }).strict(),
    response: z.array(AccessUserSummarySchema),
    handler: async (req, res) => {
      const { userId, idp, tenant, subject } = req.query;
      if ((!userId && !(idp && tenant && subject)) || (userId && (idp || tenant || subject))) {
        throw new AccessError(400, "exact_identity_required", "Supply userId or the exact idp, tenant and subject");
      }
      const user = await ctx.usersCollection.findOne(userId ? { _id: userId } : { idp, idpTenant: tenant, idpSubject: subject }, { projection: userProjection, timeoutMS: 5_000 });
      res.json(user ? [userSummary(user)] : []);
    },
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: "/api/v1/projects/:id/members/lookup/:userId", tags: ["Access"], summary: "Look up one enrolled Scope UUID for project membership management",
    params: z.object({ id: z.string().min(1), userId: z.string().uuid() }).strict(),
    response: AccessUserSummarySchema,
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const user = await ctx.usersCollection.findOne({ _id: req.params.userId }, { projection: userProjection, timeoutMS: 5_000 });
      if (!user) throw new AccessError(404, "not_found", "Enrolled user not found. Ask the person to sign in and share their Scope user ID.");
      if (user.disabledAt) throw new AccessError(409, "user_disabled", "Disabled users cannot receive new project access");
      res.json(userSummary(user));
    },
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: "/api/v1/projects/:id/members", tags: ["Access"], summary: "List project memberships (project or platform administration)",
    response: z.array(ProjectMembershipSummarySchema),
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const members = await ctx.db.collection<ProjectMembership>("project_memberships")
        .find({ projectId: req.params.id }, { timeoutMS: 5_000 }).toArray();
      const ids = members.map(member => member.userId);
      const markers = members.map(member => member.lastOperationId);
      const [users, operations] = await Promise.all([
        ids.length ? ctx.usersCollection.find({ _id: { $in: ids } }, { projection: userProjection, timeoutMS: 5_000 }).toArray() : [],
        markers.length ? ctx.db.collection<AdminOperation>("admin_operations")
          .find({ _id: { $in: markers }, state: "completed" }, { projection: { _id: 1 }, timeoutMS: 5_000 }).toArray() : [],
      ]);
      const enrolled = new Map(users.map(user => [user._id, userSummary(user)]));
      const completed = new Set(operations.map(operation => operation._id));
      const summaries: ProjectMembershipSummary[] = members.map(member => ({
        _id: member._id, projectId: member.projectId, userId: member.userId, role: member.role,
        revision: member.revision, revokedAt: member.revokedAt?.toISOString(),
        pending: !completed.has(member.lastOperationId), operationId: member.lastOperationId, user: enrolled.get(member.userId),
      }));
      res.json(summaries);
    },
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "put", path: "/api/v1/projects/:id/members/:userId", tags: ["Access"], summary: "Explicitly grant or change a project membership",
    body: membershipInput, response: z.unknown(),
    handler: async (req, res) => {
      const project = await ctx.projectStore.get(req.params.id);
      const user = await ctx.usersCollection.findOne({ _id: req.params.userId }, { timeoutMS: 5_000 });
      if (!project || !user) throw new AccessError(404, "not_found", "Project or enrolled user not found");
      if (user.disabledAt) throw new AccessError(409, "user_disabled", "Disabled users cannot receive new project access");
      const id = operationId(req);
      const actor = await auth().currentUser(req);
      const result = await auth().operations.execute({
        _id: id, actor: actor._id, reason: actor.role === "admin"
          ? "Explicit platform-admin membership assignment" : "Explicit project-admin membership assignment",
        collection: "project_memberships", targetId: `${project._id}:${user._id}`,
        expectedRevision: req.body.revision, change: { role: req.body.role }, unset: ["revokedAt"],
        initial: { projectId: project._id, userId: user._id, createdByUserId: req.user!.id },
      });
      res.status(result.state === "pending" ? 202 : 200).json(result);
    },
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "delete", path: "/api/v1/projects/:id/members/:userId", tags: ["Access"], summary: "Revoke a project membership",
    body: revisionInput, response: z.unknown(),
    handler: async (req, res) => {
      const actor = await auth().currentUser(req);
      const result = await auth().operations.execute({
        _id: operationId(req), actor: actor._id, reason: actor.role === "admin"
          ? "Explicit platform-admin membership revocation" : "Explicit project-admin membership revocation",
        collection: "project_memberships", targetId: `${req.params.id}:${req.params.userId}`,
        expectedRevision: req.body.revision, change: { revokedAt: "$operationTime" }, unset: [],
      });
      res.status(result.state === "pending" ? 202 : 200).json(result);
    },
  });
  apiRoute(ctx.app, ctx.registry, {
    method: "post", path: "/api/v1/admin/users/:id/disable", tags: ["Access"], summary: "Disable an ordinary user",
    body: revisionInput, response: z.unknown(),
    handler: async (req, res) => {
      const user = await ctx.usersCollection.findOne({ _id: req.params.id }, { timeoutMS: 5_000 });
      if (!user) throw new AccessError(404, "not_found", "User not found");
      if (user.role !== "user") throw new AccessError(403, "operator_required", "Disabling platform administrators is operator-managed");
      const result = await auth().operations.execute({
        _id: operationId(req), actor: req.user!.id, reason: "Platform-admin ordinary-user disable",
        collection: "users", targetId: user._id, expectedRevision: req.body.revision,
        change: { disabledAt: "$operationTime" }, unset: [], condition: { role: "user" },
      });
      res.status(result.state === "pending" ? 202 : 200).json(result);
    },
  });
}
