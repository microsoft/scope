// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { performance } from "node:perf_hooks";
import type { Db, Document } from "mongodb";
import type { Request, Response } from "express";
import { ANONYMOUS_USER_ID, MembershipSchema, projectPermissions, parseProfileSpec, parseExtensionSpec, type AccessCapabilities, type ProjectPermission, type ProjectMembership, type UserDocument } from "shared";
import { AccessError, AdminOperations } from "./admin-operations.js";
import type { CallerPrincipal } from "./types.js";

export type RoutePolicy = "public" | "self" | "platform" | "metadata" | "projects" | "project" | "disabled";
const publicPaths = new Set(["/health", "/ready", "/about", "/api/v1/version"]);
const collections: Readonly<Record<string, string>> = {
  requests: "requests", reports: "reports", insights: "insights", profiles: "profiles",
  criteria: "criteria", "prompt-features": "prompt-features", "task-prompts": "task-prompts",
  skills: "skills", "skill-revisions": "skill-revisions", codebases: "codebases",
  "codebase-revisions": "codebase-revisions", resources: "resources",
  extensions: "extensions", "report-templates": "report-templates", "mcp/servers": "mcp-servers",
};
const pointParams = ["id", "profileId", "ref"];
const readOnlyPosts = new Set(["/api/v1/reports/bulk-status", "/api/v1/reports/bulk-summary", "/api/v1/requests/archive"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE_MS = 20_000;

/** Route-level options passed from the route definition to {@link Authorization.guard}. */
export interface GuardOptions {
  /** The route accepts run tokens (`runToken: true` on the route definition). */
  runToken?: boolean;
}

/**
 * Routes each service scope grants, as `<method> <route pattern>`. A service
 * caller may call only the routes covered by its scopes; everything else is 403.
 */
export const SERVICE_SCOPE_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "agents:read": ["get /api/v1/agents", "head /api/v1/agents"],
  "agents:register": ["post /api/v1/agents", "post /api/v1/agents/:id/versions"],
  "models:sync": ["post /api/v1/models/sync"],
});

/** Whose access a project-scoped request is checked against. */
type ProjectAccess =
  | { kind: "user"; userId: string }
  | { kind: "run"; projectId: string };

export function routePolicy(method: string, path: string): RoutePolicy {
  if (publicPaths.has(path)) return "public";
  if (path === "/api/v1/users/me") return "self";
  if (path.startsWith("/api/v1/admin/")) return "platform";
  if (/^\/api\/v1\/(keys|accounts|feature-flags)(\/|$)/.test(path)) return "platform";
  if (/^\/api\/v1\/(agents|models)(\/|$)/.test(path)) return method === "get" ? "metadata" : "platform";
  if (path.startsWith("/api/v1/projects")) return "projects";
  if (path.startsWith("/api/v1/reports") && method !== "get" && !readOnlyPosts.has(path)) return "disabled";
  if (Object.keys(collections).some(root => path === `/api/v1/${root}` || path.startsWith(`/api/v1/${root}/`)) ||
    ["/api/v1/analysis", "/api/v1/runs/upload", "/api/v1/runs/upload-batch"].includes(path)) return "project";
  throw new Error(`Unclassified API route: ${method.toUpperCase()} ${path}`);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export class Authorization {
  readonly operations: AdminOperations;
  constructor(readonly db: Db, readonly enabled = true) { this.operations = new AdminOperations(db); }

  private readOptions(deadline: number): { timeoutMS: number } {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new AccessError(503, "authority_timeout", "Authorization freshness budget exceeded");
    return { timeoutMS: Math.max(1, Math.min(5_000, Math.floor(remaining))) };
  }

  async currentUser(req: Request, deadline = performance.now() + LEASE_MS): Promise<UserDocument> {
    // Run and service callers never resolve to a user record.
    if (req.principal) throw new AccessError(403, "user_required", "This operation requires a signed-in user");
    if (!req.auth || !req.user?.isAuthenticated) throw new AccessError(401, "authentication_required", "Authentication required");
    const user = await this.db.collection<UserDocument & { lastOperationId?: string }>("users")
      .findOne({ _id: req.user.id }, this.readOptions(deadline));
    if (!user || user.disabledAt) throw new AccessError(403, "access_denied", "User is missing or disabled");
    if (user.role !== "user" && user.role !== "admin") {
      console.error("Invalid platform role", user._id);
      throw new AccessError(503, "authority_invalid", "Authorization authority is invalid");
    }
    if (!await this.operations.isComplete(user.lastOperationId, this.readOptions(deadline).timeoutMS)) throw new AccessError(503, "operation_pending", "Access change is pending operator repair");
    return user;
  }

  async memberships(userId: string, deadline = performance.now() + LEASE_MS): Promise<ProjectMembership[]> {
    const records = await this.db.collection("project_memberships")
      .find({ userId, revokedAt: { $exists: false } }, this.readOptions(deadline)).toArray();
    const valid: ProjectMembership[] = [];
    for (const raw of records) {
      if (performance.now() >= deadline) throw new AccessError(503, "authority_timeout", "Authorization freshness budget exceeded");
      const parsed = MembershipSchema.safeParse(raw);
      if (!parsed.success) {
        console.error("Invalid project membership", raw._id);
        throw new AccessError(503, "authority_invalid", "Authorization authority is invalid");
      }
      const project = await this.db.collection<Document & { _id: string }>("projects")
        .findOne({ _id: parsed.data.projectId, deletedAt: { $exists: false } }, this.readOptions(deadline));
      if (project && await this.operations.isComplete(project.lastOperationId, this.readOptions(deadline).timeoutMS) &&
        await this.operations.isComplete(parsed.data.lastOperationId, this.readOptions(deadline).timeoutMS)) valid.push(parsed.data);
    }
    return valid;
  }

  async capabilities(req: Request): Promise<AccessCapabilities> {
    return this.withBudget(deadline => this.readCapabilities(req, deadline));
  }

  private async readCapabilities(req: Request, deadline: number): Promise<AccessCapabilities> {
    const user = await this.currentUser(req, deadline);
    const memberships = await this.memberships(user._id, deadline);
    this.readOptions(deadline);
    return {
      platformAdmin: user.role === "admin", reportsEnabled: false,
      memberships: memberships.map(m => ({
        projectId: m.projectId, role: m.role, permissions: projectPermissions(m.role), revision: m.revision,
      })),
    };
  }

  async requireProject(userId: string, projectId: string, permission: ProjectPermission, deadline = performance.now() + LEASE_MS): Promise<void> {
    if (!this.enabled) {
      const project = await this.db.collection<Document & { _id: string }>("projects")
        .findOne({ _id: projectId, deletedAt: { $exists: false } }, this.readOptions(deadline));
      if (!project) throw new AccessError(404, "not_found", "Not found");
      return;
    }
    const memberships = await this.memberships(userId, deadline);
    const membership = memberships.find(m => m.projectId === projectId);
    if (!membership) throw new AccessError(404, "not_found", "Not found");
    if (!projectPermissions(membership.role).includes(permission)) {
      throw new AccessError(403, "insufficient_permission", "Insufficient project permission");
    }
  }

  private async scopedDocument(collection: string, id: string, projectId: string | undefined, deadline: number): Promise<Document & { _id: string }> {
    const query: Record<string, unknown> = uuid.test(id) ? { _id: id } :
      projectId ? { projectId, $or: [{ _id: id }, { id }, { slug: id }, { ref: id }] } : {};
    if (!Object.keys(query).length) throw new AccessError(400, "project_required", "A projectId is required for a non-UUID identifier");
    if (projectId) query.projectId = projectId;
    const doc = await this.db.collection<Document & { _id: string }>(collection)
      .findOne(query, this.readOptions(deadline));
    if (!doc || !text(doc.projectId)) throw new AccessError(404, "not_found", "Not found");
    return doc;
  }

  async guard(req: Request, method: string, path: string, policy: RoutePolicy, options: GuardOptions = {}): Promise<number> {
    return this.withBudget(deadline => this.decide(req, method, path, policy, options, deadline));
  }

  private async withBudget<T>(read: (deadline: number) => Promise<T>): Promise<T> {
    const deadline = performance.now() + LEASE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([read(deadline), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AccessError(503, "authority_timeout", "Authorization freshness budget exceeded")), LEASE_MS);
        timer.unref();
      })]);
    } catch (error) {
      if (error instanceof AccessError) throw error;
      console.error("Authorization authority unavailable", error);
      throw new AccessError(503, "authority_unavailable", "Authorization authority unavailable");
    } finally { if (timer) clearTimeout(timer); }
  }

  private async decide(req: Request, method: string, path: string, policy: RoutePolicy, options: GuardOptions, budgetDeadline: number): Promise<number> {
    const started = budgetDeadline - LEASE_MS;
    if (policy === "disabled") throw new AccessError(503, "report_generation_disabled", "New report generation is disabled");
    if (policy === "public" || policy === "self") return started + LEASE_MS;
    if (!this.enabled) {
      if (path.startsWith("/api/v1/admin/") || /^\/api\/v1\/projects\/[^/]+\/members(?:\/|$)/.test(path)) {
        throw new AccessError(503, "authentication_disabled", "Access administration requires authentication to be enabled");
      }
      if (policy === "project") await this.projectRequest(req, method, path, { kind: "user", userId: req.user?.id ?? ANONYMOUS_USER_ID }, budgetDeadline);
      return started + LEASE_MS;
    }
    try {
      // Run and service callers carry no IdP token, so there is no JWT lease to cap.
      if (req.principal) {
        await this.decideCaller(req, req.principal, method, path, policy, options, budgetDeadline);
        return started + LEASE_MS;
      }
      const user = await this.currentUser(req, budgetDeadline);
      if (policy === "platform") {
        if (user.role !== "admin") throw new AccessError(403, "insufficient_permission", "Platform administration required");
      } else if (policy === "metadata") {
        if (user.role !== "admin" && !(await this.memberships(user._id, budgetDeadline)).length) throw new AccessError(403, "membership_required", "An active project membership is required");
      } else if (policy === "projects") {
        const membership = /^\/api\/v1\/projects\/:id\/members(?:\/|$)/.test(path);
        const control = !membership && (method === "delete" || method === "post" ||
          (path === "/api/v1/projects" && req.query.controlPlane === "true"));
        if (control && user.role !== "admin") throw new AccessError(403, "insufficient_permission", "Platform administration required");
        if (!control && req.params.id && user.role !== "admin") {
          await this.requireProject(user._id, req.params.id, membership ? "members:write" : method === "get" ? "content:read" : "settings:write", budgetDeadline);
        }
      } else {
        await this.projectRequest(req, method, path, { kind: "user", userId: user._id }, budgetDeadline);
      }
      // The unchanged bytes have already passed the IdP verifier.
      const claims: unknown = req.auth
        ? JSON.parse(Buffer.from(req.auth.token.split(".")[1], "base64url").toString("utf8")) : null;
      const exp = record(claims).exp;
      const remaining = typeof exp === "number" ? exp * 1000 - Date.now() : 0;
      const deadline = Math.min(started + LEASE_MS, performance.now() + remaining);
      if (deadline <= performance.now()) throw new AccessError(503, "authority_timeout", "Authorization could not be validated within its freshness budget");
      return deadline;
    } catch (error) {
      if (error instanceof AccessError) throw error;
      console.error("Authorization authority unavailable", error);
      throw new AccessError(503, "authority_unavailable", "Authorization authority unavailable");
    }
  }

  /**
   * Authorize a run or service caller. Run tokens are limited to opted-in
   * GET/HEAD project routes in the run's own project; service keys are limited
   * to the routes their scopes grant.
   */
  private async decideCaller(req: Request, principal: CallerPrincipal, method: string, path: string, policy: RoutePolicy, options: GuardOptions, deadline: number): Promise<void> {
    if (principal.kind === "service") {
      const route = `${method} ${path}`;
      if (!principal.scopes.some(scope => SERVICE_SCOPE_ROUTES[scope]?.includes(route))) {
        throw new AccessError(403, "insufficient_scope", "Service is not allowed to call this route");
      }
      return;
    }
    if (!options.runToken || (method !== "get" && method !== "head") || policy !== "project") {
      throw new AccessError(403, "run_token_not_allowed", "Run tokens are not accepted on this route");
    }
    await this.projectRequest(req, method, path, { kind: "run", projectId: principal.projectId }, deadline);
  }

  /** A run may read only its own, non-deleted project; anything else looks absent. */
  private async requireRunProject(runProjectId: string, projectId: string, deadline: number): Promise<void> {
    if (runProjectId !== projectId) throw new AccessError(404, "not_found", "Not found");
    const project = await this.db.collection<Document & { _id: string }>("projects")
      .findOne({ _id: projectId, deletedAt: { $exists: false } }, this.readOptions(deadline));
    if (!project) throw new AccessError(404, "not_found", "Not found");
  }

  private async projectRequest(req: Request, method: string, path: string, access: ProjectAccess, deadline: number): Promise<void> {
    let projectId = text(req.query.projectId);
    const body = record(req.body);
    const root = Object.keys(collections).find(key => path === `/api/v1/${key}` || path.startsWith(`/api/v1/${key}/`));
    const identifier = pointParams.map(key => text(req.params[key])).find(Boolean)?.replace(/\/archive$/, "");
    if (root && identifier) {
      const collection = path === "/api/v1/resources/revisions/:id" ? "resource-revisions" : collections[root];
      const doc = await this.scopedDocument(collection, identifier, projectId, deadline);
      projectId = text(doc.projectId);
    }
    const requestId = text(req.query.requestId) ?? text(body.requestId);
    if (requestId) {
      const request = await this.scopedDocument("requests", requestId, projectId, deadline);
      projectId = text(request.projectId);
    }
    const sourceReportId = text(body.sourceReportId);
    if (sourceReportId) {
      const report = await this.scopedDocument("reports", sourceReportId, projectId, deadline);
      projectId = text(report.projectId);
    }
    if (!projectId) throw new AccessError(400, "project_required", "A projectId is required");
    if (text(body.projectId) && body.projectId !== projectId) throw new AccessError(404, "not_found", "Not found");
    const permission = method === "get" || method === "head" || readOnlyPosts.has(path)
      ? "content:read" : method === "delete" ? "content:delete" : "content:write";
    if (access.kind === "run") await this.requireRunProject(access.projectId, projectId, deadline);
    else await this.requireProject(access.userId, projectId, permission, deadline);
    req.authorizedProjectId = projectId;
    // Bulk identifiers and referenced documents cannot widen the authorized scope.
    for (const key of ["ids", "requestIds", "reportIds"]) {
      const ids = body[key];
      if (Array.isArray(ids)) for (const id of ids) {
        if (typeof id !== "string") throw new AccessError(400, "invalid_reference", "Invalid reference");
        await this.scopedDocument(key === "reportIds" ? "reports" : key === "requestIds" ? "requests" : collections[root ?? "requests"] ?? "requests", id, projectId, deadline);
      }
    }
    await this.references(body, projectId, deadline);
  }

  private async references(body: Record<string, unknown>, projectId: string, deadline: number): Promise<void> {
    this.readOptions(deadline);
    const refs: Readonly<Record<string, string>> = {
      profileId: "profiles", taskPromptId: "task-prompts", promptId: "task-prompts",
      agentsMdPromptId: "task-prompts", insightId: "insights", codebaseId: "codebases",
      codebaseRevisionId: "codebase-revisions", resourceId: "resources", sourceReportId: "reports",
    };
    for (const [key, collection] of Object.entries(refs)) {
      const spec = text(body[key]);
      if (!spec) continue;
      let id = spec;
      if (key === "profileId") {
        try { id = parseProfileSpec(spec).profileId; }
        catch { throw new AccessError(400, "invalid_reference", "Invalid profile reference"); }
      }
      await this.scopedDocument(collection, id, projectId, deadline);
    }
    const arrays: Readonly<Record<string, string>> = {
      criteria: "criteria", criteriaIds: "criteria", dependsOn: "criteria",
      taskPromptIds: "task-prompts", agentsMdParentIds: "task-prompts",
      featureIds: "prompt-features", mcpServers: "mcp-servers",
      skillRevisions: "skill-revisions", skills: "skills", profileVariations: "profiles",
      extensions: "extensions",
    };
    for (const [key, collection] of Object.entries(arrays)) {
      const values = body[key];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value !== "string") throw new AccessError(400, "invalid_reference", "Invalid reference");
        let id = value;
        if (key === "profileVariations") {
          try { id = parseProfileSpec(value).profileId; }
          catch { throw new AccessError(400, "invalid_reference", "Invalid profile reference"); }
        }
        if (key === "extensions") id = parseExtensionSpec(value).id;
        await this.scopedDocument(collection, id, projectId, deadline);
      }
    }
    const codebase = text(body.codebase);
    if (codebase) await this.scopedDocument(uuid.test(codebase) || /@r\d+$/.test(codebase) ? "codebase-revisions" : "codebases", codebase, projectId, deadline);
    if (Array.isArray(body.resources)) for (const value of body.resources) {
      const spec = text(value) ?? text(record(value).revisionId) ?? text(record(value).ref);
      if (!spec) throw new AccessError(400, "invalid_reference", "Invalid resource reference");
      await this.scopedDocument(uuid.test(spec) || /@r\d+$/.test(spec) ? "resource-revisions" : "resources", spec, projectId, deadline);
    }
    for (const key of ["scenario", "overrides"]) {
      if (body[key] !== undefined) await this.references(record(body[key]), projectId, deadline);
    }
    if (Array.isArray(body.gates)) for (const gate of body.gates) await this.references(record(gate), projectId, deadline);
  }
}

type LeaseResponse = Pick<Response, "write"> & { end(): unknown; once(event: "close", listener: () => void): unknown };

export function protectStream(res: LeaseResponse, revalidate: () => Promise<number>, initialDeadline: number): void {
  let deadline = initialDeadline;
  let checking = false;
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    res.end();
  };
  const write = res.write.bind(res);
  res.write = (chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    if (closed || performance.now() >= deadline) { stop(); return false; }
    return typeof encoding === "string" ? write(chunk, encoding, callback) : write(chunk, encoding);
  };
  const timer = setInterval(() => {
    if (performance.now() >= deadline) { stop(); return; }
    if (checking) return;
    checking = true;
    void revalidate().then(value => { if (!closed) deadline = value; }, error => {
      console.warn("Closing unauthorized stream", error instanceof Error ? error.message : error);
      stop();
    }).finally(() => { checking = false; });
  }, 1_000);
  timer.unref();
  res.once("close", () => { closed = true; clearInterval(timer); });
}
