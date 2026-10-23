// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  CreateExtensionInputSchema,
  ExtensionClient,
  ExtensionResponseSchema,
  ExtensionSearchResultSchema,
  ExtensionVersionInfoSchema,
  UpdateExtensionInputSchema,
} from "shared";
import type { ExtensionSearchResult } from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { ExtensionDocument, RouteContext } from "../route-context.js";
import { ProjectIdQuerySchema, getQueryProjectId } from "../utils/project-scope.js";

export function registerExtensionsRoutes(ctx: RouteContext): void {

// =====================================================================
// Extensions API (VS Code Extensions)
// =====================================================================

/** Public identifier for an extension = its human slug (falls back to legacy _id-as-slug rows). */
const extensionSlug = (e: ExtensionDocument): string => e.slug ?? e._id;

/**
 * Map a stored extension doc to the API response shape.
 *
 * After migration 026, `_id` is an internal random UUID and the human slug lives
 * in `slug`. The API contract speaks only in slugs, so we mask `_id` back to the
 * slug on the way out and never leak the internal UUID (`id` and `slug` both = the
 * human slug too). Legacy rows (pre-026) still have `_id === slug`, so masking is a
 * no-op for them. Mirrors `versionResponse` in profiles.ts / `toMcpResponse`.
 */
const toExtensionResponse = (e: ExtensionDocument): ExtensionDocument & { id: string } => ({
  ...e,
  _id: extensionSlug(e),
  slug: extensionSlug(e),
  id: extensionSlug(e),
});

/**
 * Resolve an extension by its human slug (`{publisher}.{name}`), **always scoped
 * to a project**.
 *
 * New rows key `_id` to a random UUID and carry the slug in `slug`; legacy rows
 * (pre-migration 026) still have `_id === slug`. The lookup is confined to
 * `projectId` (slugs may repeat across projects), trying the `slug` field first
 * then the legacy `_id` for un-backfilled rows. There is **no global slug-only
 * fallback**: a project-scoped entity is never resolved by slug alone.
 */
const findExtensionBySlug = async (
  slug: string,
  projectId: string,
): Promise<ExtensionDocument | null> => {
  const bySlug = await ctx.extensionCollection.findOne({
    projectId,
    slug,
    deletedAt: { $exists: false },
  });
  if (bySlug) return bySlug as ExtensionDocument;
  return (await ctx.extensionCollection.findOne({
    projectId,
    _id: slug,
    deletedAt: { $exists: false },
  })) as ExtensionDocument | null;
};

// GET /api/v1/extensions — list all extensions
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/extensions",
  tags: ["Extensions"],
  summary: "List all extensions",
  query: ProjectIdQuerySchema,
  response: z.array(ExtensionResponseSchema),
  handler: async (req, res) => {
    const extensions = await ctx.extensionCollection
      .find({ projectId: getQueryProjectId(req), deletedAt: { $exists: false } })
      .toArray();
    extensions.sort((a, b) => extensionSlug(a as ExtensionDocument).localeCompare(extensionSlug(b as ExtensionDocument)));
    res.json(extensions.map((e) => toExtensionResponse(e as ExtensionDocument)));
  },
});

// GET /api/v1/extensions/search — search internal DB + VS Code marketplace
// MUST be defined before /:id to avoid being caught by the route param
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/extensions/search",
  tags: ["Extensions"],
  summary: "Search extensions (internal + marketplace)",
  query: z.object({ q: z.string(), limit: z.string().optional() }).merge(ProjectIdQuerySchema),
  response: z.array(ExtensionSearchResultSchema),
  errorResponses: {
    400: { description: "Missing query parameter" },
  },
  handler: async (req, res, next) => {
    try {
      const { q, limit: limitStr } = req.query;
      const projectId = getQueryProjectId(req);

      if (!q || typeof q !== "string" || !q.trim()) {
        res.status(400).json({ error: "Query parameter 'q' is required" });
        return;
      }

      const limit = Math.min(Math.max(parseInt(limitStr as string, 10) || 10, 1), 50);
      const query = q.trim();

      // Search internal DB (case-insensitive regex), scoped to the project
      const regex = { $regex: query, $options: "i" };
      const internalExtensions = await ctx.extensionCollection
        .find({
          deletedAt: { $exists: false },
          projectId,
          $or: [
            { slug: regex },
            { _id: regex },
            { name: regex },
            { publisher: regex },
            { description: regex },
          ],
        })
        .limit(limit)
        .toArray();

      const internalResults: ExtensionSearchResult[] = internalExtensions.map((e) => ({
        id: extensionSlug(e as ExtensionDocument),
        name: e.name,
        publisher: e.publisher,
        description: e.description,
        internal: true,
      }));

      const internalIds = new Set(internalExtensions.map((e) => extensionSlug(e as ExtensionDocument)));

      // Search VS Code marketplace
      let externalResults: ExtensionSearchResult[] = [];
      try {
        const extensionClient = new ExtensionClient("");
        const marketplaceResults = await extensionClient.searchMarketplace(query, limit);
        externalResults = marketplaceResults.filter((r: ExtensionSearchResult) => !internalIds.has(r.id));
      } catch {
        console.warn("VS Code marketplace search failed, returning only internal results");
      }

      const results = [...internalResults, ...externalResults].slice(0, limit);
      res.json(results);
    } catch (error) {
      next(error);
    }
  },
});

// GET /api/v1/extensions/:id — get extension by ID
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/extensions/:id",
  runToken: true,
  tags: ["Extensions"],
  summary: "Get extension by ID",
  params: z.object({ id: z.string() }),
  query: ProjectIdQuerySchema,
  response: ExtensionResponseSchema,
  handler: async (req, res) => {
    const extension = await findExtensionBySlug(req.params.id, getQueryProjectId(req));
    if (!extension) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }
    res.json(toExtensionResponse(extension));
  },
});

// POST /api/v1/extensions — create/import extension (upserts if soft-deleted)
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/extensions",
  tags: ["Extensions"],
  summary: "Create or import an extension",
  query: ProjectIdQuerySchema,
  body: CreateExtensionInputSchema,
  response: ExtensionResponseSchema,
  handler: async (req, res) => {
    const projectId = getQueryProjectId(req);
    const { _id: slug, publisher, name, description, origin } = req.body;
    const now = new Date();
    // Same-project lookup by slug (new rows) or legacy _id-as-slug rows.
    const existing = await ctx.extensionCollection.findOne({
      projectId,
      $or: [{ slug }, { _id: slug }],
    });

    if (existing) {
      await ctx.extensionCollection.updateOne(
        { _id: existing._id },
        {
          $set: {
            slug,
            publisher,
            name,
            ...(description !== undefined ? { description } : {}),
            origin,
            updatedAt: now,
          },
          $unset: { deletedAt: "" },
        },
      );
      const updated = await ctx.extensionCollection.findOne({ _id: existing._id });
      res.json(toExtensionResponse(updated as ExtensionDocument));
    } else {
      const extensionDoc: ExtensionDocument = {
        _id: randomUUID(),
        slug,
        projectId,
        publisher,
        name,
        ...(description ? { description } : {}),
        origin,
        createdAt: now,
      };
      await ctx.extensionCollection.insertOne(extensionDoc);
      res.status(201).json(toExtensionResponse(extensionDoc));
    }
  },
});

// PUT /api/v1/extensions/:id — update extension
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/extensions/:id",
  tags: ["Extensions"],
  summary: "Update extension",
  params: z.object({ id: z.string() }),
  query: ProjectIdQuerySchema,
  body: UpdateExtensionInputSchema,
  response: ExtensionResponseSchema,
  handler: async (req, res) => {
    const { name, description } = req.body;

    const existing = await findExtensionBySlug(req.params.id, getQueryProjectId(req));
    if (!existing) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updateFields.name = name;
    if (description !== undefined) updateFields.description = description;

    await ctx.extensionCollection.updateOne({ _id: existing._id }, { $set: updateFields });
    const updated = await ctx.extensionCollection.findOne({ _id: existing._id });
    res.json(toExtensionResponse(updated as ExtensionDocument));
  },
});

// DELETE /api/v1/extensions/:id — soft-delete extension
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/extensions/:id",
  tags: ["Extensions"],
  summary: "Delete extension",
  params: z.object({ id: z.string() }),
  query: ProjectIdQuerySchema,
  response: z.object({ message: z.string() }),
  successStatus: 204,
  handler: async (req, res) => {
    const existing = await findExtensionBySlug(req.params.id, getQueryProjectId(req));
    if (!existing) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }

    await ctx.extensionCollection.updateOne(
      { _id: existing._id },
      { $set: { deletedAt: new Date(), updatedAt: new Date() } },
    );

    res.status(204).send();
  },
});

// GET /api/v1/extensions/:id/versions — list available versions from VS Code marketplace
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/extensions/:id/versions",
  tags: ["Extensions"],
  summary: "List available versions for an extension",
  params: z.object({ id: z.string() }),
  query: z.object({ preRelease: z.string().optional() }),
  response: z.array(ExtensionVersionInfoSchema),
  handler: async (req, res, next) => {
    try {
      const includePreRelease = req.query.preRelease === "true";
      const extensionClient = new ExtensionClient("");
      const versions = await extensionClient.getVersions(req.params.id, includePreRelease);
      res.json(versions);
    } catch (error) {
      next(error);
    }
  },
});

}
