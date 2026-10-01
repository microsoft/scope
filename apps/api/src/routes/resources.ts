// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  buildResourceRevisionRef,
  CreateResourceInputSchema,
  CreateResourceRevisionInputSchema,
  ResourceResponseSchema,
  ResourceRevisionResponseSchema,
  slugifyResourceName,
  UpdateResourceInputSchema,
  validateParameterDeclarations,
  ResourceParameterError,
  type ResourceDocument,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import { ProjectIdQuerySchema, getQueryProjectId } from "../utils/project-scope.js";

async function resolveResource(
  ctx: RouteContext,
  projectId: string,
  idOrSlug: string
): Promise<ResourceDocument | null> {
  const byId = await ctx.resourceStore.get(idOrSlug);
  if (byId) return byId.projectId === projectId ? byId : null;
  return ctx.resourceStore.getBySlug(projectId, idOrSlug);
}

/**
 * Existing resource holding this slug, including a soft-deleted one.
 *
 * Returned rather than a boolean so the caller can say *why* the slug is taken:
 * a soft-deleted resource is invisible in every listing, so a bare "already
 * exists" sends the caller hunting for something they cannot see.
 */
async function findResourceBySlugIncludingDeleted(ctx: RouteContext, projectId: string, slug: string) {
  return ctx.resourceStore.getBySlug(projectId, slug, { includeDeleted: true });
}

async function hasRevisionRef(ctx: RouteContext, projectId: string, ref: string): Promise<boolean> {
  return (await ctx.resourceRevisionStore.getByRef(projectId, ref)) !== null;
}

export function registerResourcesRoutes(ctx: RouteContext): void {
  // ===================================================================
  // Resources API
  // ===================================================================

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/resources",
    tags: ["Resources"],
    summary: "List all resources",
    query: ProjectIdQuerySchema,
    response: z.array(ResourceResponseSchema),
    handler: async (req, res, next) => {
      try {
        const resources = await ctx.resourceStore.list({ projectId: getQueryProjectId(req) });
        res.json(resources.map((resource) => ({ ...resource, id: resource._id })));
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/resources",
    tags: ["Resources"],
    summary: "Create a resource and its first revision",
    query: ProjectIdQuerySchema,
    body: CreateResourceInputSchema,
    response: ResourceResponseSchema,
    rawResponse: true,
    successStatus: 201,
    errorResponses: {
      400: { description: "Invalid input" },
      409: { description: "Resource slug or revision ref already exists in this project" },
    },
    handler: async (req, res, next) => {
      try {
        const projectId = getQueryProjectId(req);
        const { name, slug: requestedSlug, description, setup, teardown, exports: exportedNames, parameters, creator } = req.body;
        const slug = slugifyResourceName(requestedSlug ?? name);
        if (!slug) {
          res.status(400).json({ error: "Could not derive a valid slug from the resource name" });
          return;
        }
        try {
          validateParameterDeclarations(parameters, exportedNames);
        } catch (error) {
          if (error instanceof ResourceParameterError) {
            res.status(400).json({ error: error.message });
            return;
          }
          throw error;
        }

        // Cosmos DB degrades the project-scoped unique index to non-unique, so
        // the route must enforce same-project uniqueness before insert. A
        // soft-deleted resource still reserves its slug so old refs stay stable.
        const slugHolder = await findResourceBySlugIncludingDeleted(ctx, projectId, slug);
        if (slugHolder) {
          res.status(409).json({
            error: slugHolder.deletedAt
              ? `A deleted resource still holds the slug '${slug}' in this project. Slugs are not released on delete, because existing runs resolve revisions by the '{slug}@rN' ref and reusing the slug would make those refs ambiguous. Choose a different slug.`
              : `A resource with slug '${slug}' already exists in this project.`,
          });
          return;
        }

        const firstRef = buildResourceRevisionRef(slug, 1);
        if (await hasRevisionRef(ctx, projectId, firstRef)) {
          res.status(409).json({ error: `A resource revision with ref '${firstRef}' already exists in this project.` });
          return;
        }

        const resource = await ctx.resourceStore.create({
          projectId,
          name,
          slug,
          ...(description ? { description } : {}),
          ...(creator ? { creator } : {}),
        });

        try {
          const result = await ctx.resourceResolver.createRevision(
            resource,
            {
              setup,
              ...(teardown ? { teardown } : {}),
              ...(exportedNames ? { exports: exportedNames } : {}),
              ...(parameters ? { parameters } : {}),
              ...(creator ? { creator } : {}),
            },
            ctx.resourceRevisionStore
          );
          const fresh = (await ctx.resourceStore.get(resource._id)) ?? resource;
          res.status(201).json({ ...fresh, id: fresh._id, firstRevision: result.revision });
        } catch (revisionError) {
          await ctx.resourceRevisionStore.deleteByResource(resource._id);
          await ctx.resourceStore.hardDelete(resource._id);
          const message = revisionError instanceof Error ? revisionError.message : String(revisionError);
          res.status(400).json({ error: `Failed to create the first resource revision: ${message}` });
        }
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/resources/:id",
    tags: ["Resources"],
    summary: "Get a resource",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    response: ResourceResponseSchema,
    errorResponses: { 404: { description: "Resource not found" } },
    handler: async (req, res, next) => {
      try {
        const resource = await resolveResource(ctx, getQueryProjectId(req), req.params.id);
        if (!resource) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }
        res.json({ ...resource, id: resource._id });
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "patch",
    path: "/api/v1/resources/:id",
    tags: ["Resources"],
    summary: "Update a resource",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    body: UpdateResourceInputSchema,
    response: ResourceResponseSchema,
    errorResponses: { 404: { description: "Resource not found" } },
    handler: async (req, res, next) => {
      try {
        const resource = await resolveResource(ctx, getQueryProjectId(req), req.params.id);
        if (!resource) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }
        const updated = await ctx.resourceStore.update(resource._id, req.body);
        if (!updated) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }
        res.json({ ...updated, id: updated._id });
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "delete",
    path: "/api/v1/resources/:id",
    tags: ["Resources"],
    summary: "Delete a resource",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    response: z.any(),
    rawResponse: true,
    successStatus: 204,
    errorResponses: { 404: { description: "Resource not found" } },
    handler: async (req, res, next) => {
      try {
        const resource = await resolveResource(ctx, getQueryProjectId(req), req.params.id);
        if (!resource) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }
        const ok = await ctx.resourceStore.softDelete(resource._id);
        if (!ok) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }
        await ctx.resourceRevisionStore.softDeleteByResource(resource._id);
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  });

  // ===================================================================
  // Resource Revisions API
  // ===================================================================

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/resources/:id/revisions",
    tags: ["Resource Revisions"],
    summary: "List resource revisions",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema.merge(z.object({ limit: z.string().optional() })),
    response: z.array(ResourceRevisionResponseSchema),
    errorResponses: { 404: { description: "Resource not found" } },
    handler: async (req, res, next) => {
      try {
        const resource = await resolveResource(ctx, getQueryProjectId(req), req.params.id);
        if (!resource) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }
        const limitStr = req.query.limit as string | undefined;
        const limit = Math.min(Math.max(parseInt(limitStr ?? "50", 10), 1), 200);
        const revisions = await ctx.resourceRevisionStore.listByResource(resource._id, { limit });
        res.json(revisions);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/resources/:id/revisions",
    tags: ["Resource Revisions"],
    summary: "Create a resource revision",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    body: CreateResourceRevisionInputSchema,
    response: ResourceRevisionResponseSchema,
    rawResponse: true,
    successStatus: 201,
    errorResponses: {
      404: { description: "Resource not found" },
      409: { description: "Resource revision ref already exists in this project" },
    },
    handler: async (req, res, next) => {
      try {
        const resource = await resolveResource(ctx, getQueryProjectId(req), req.params.id);
        if (!resource) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }

        // Application-level scoped ref guard for Cosmos DB, where the unique
        // index degrades to non-unique. The atomic counter remains authoritative;
        // this catches pre-existing/corrupt collisions before the insert path.
        const nextRef = buildResourceRevisionRef(resource.slug, resource.revisionCounter + 1);
        if (await hasRevisionRef(ctx, resource.projectId, nextRef)) {
          res.status(409).json({ error: `A resource revision with ref '${nextRef}' already exists in this project.` });
          return;
        }

        const { setup, teardown, exports: exportedNames, parameters, creator } = req.body;
        try {
          validateParameterDeclarations(parameters, exportedNames);
        } catch (error) {
          if (error instanceof ResourceParameterError) {
            res.status(400).json({ error: error.message });
            return;
          }
          throw error;
        }
        const result = await ctx.resourceResolver.createRevision(
          resource,
          {
            setup,
            ...(teardown ? { teardown } : {}),
            ...(exportedNames ? { exports: exportedNames } : {}),
            ...(parameters ? { parameters } : {}),
            ...(creator ? { creator } : {}),
          },
          ctx.resourceRevisionStore
        );
        res
          .status(result.deduplicated ? 200 : 201)
          .json({ ...result.revision, deduplicated: result.deduplicated });
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/resources/:id/revisions/latest",
    tags: ["Resource Revisions"],
    summary: "Get the latest resource revision",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    response: ResourceRevisionResponseSchema,
    errorResponses: { 404: { description: "Revision not found" } },
    handler: async (req, res, next) => {
      try {
        const resource = await resolveResource(ctx, getQueryProjectId(req), req.params.id);
        if (!resource) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }
        const revision = await ctx.resourceRevisionStore.getLatest(resource._id);
        if (!revision) {
          res.status(404).json({ error: "Resource revision not found" });
          return;
        }
        res.json(revision);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/resources/:id/revisions/:revisionNumber",
    tags: ["Resource Revisions"],
    summary: "Get a resource revision by resource and revision number",
    params: z.object({ id: z.string(), revisionNumber: z.string() }),
    query: ProjectIdQuerySchema,
    response: ResourceRevisionResponseSchema,
    errorResponses: { 404: { description: "Revision not found" } },
    handler: async (req, res, next) => {
      try {
        const revisionNumber = Number(req.params.revisionNumber);
        if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
          res.status(404).json({ error: "Resource revision not found" });
          return;
        }
        const resource = await resolveResource(ctx, getQueryProjectId(req), req.params.id);
        if (!resource) {
          res.status(404).json({ error: "Resource not found" });
          return;
        }
        const revision = await ctx.resourceRevisionStore.getByNumber(resource._id, revisionNumber);
        if (!revision) {
          res.status(404).json({ error: "Resource revision not found" });
          return;
        }
        res.json(revision);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/resources/revisions/:id",
    tags: ["Resource Revisions"],
    summary: "Get resource revision by id",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    response: ResourceRevisionResponseSchema,
    errorResponses: { 404: { description: "Revision not found" } },
    handler: async (req, res, next) => {
      try {
        const revision = await ctx.resourceRevisionStore.get(req.params.id);
        if (!revision || revision.projectId !== getQueryProjectId(req)) {
          res.status(404).json({ error: "Resource revision not found" });
          return;
        }
        res.json(revision);
      } catch (error) {
        next(error);
      }
    },
  });
}
