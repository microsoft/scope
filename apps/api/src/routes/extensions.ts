// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { CreateExtensionInputSchema, ExtensionResponseSchema, ExtensionSearchResultSchema, ExtensionVersionInfoSchema, UpdateExtensionInputSchema } from "@scope/core";
import { ExtensionClient } from "@scope/platform";
import type { ExtensionSearchResult } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { ExtensionDocument, RouteContext } from "../route-context.js";

export function registerExtensionsRoutes(ctx: RouteContext): void {

// =====================================================================
// Extensions API (VS Code Extensions)
// =====================================================================

// GET /api/v1/extensions — list all extensions
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/extensions",
  tags: ["Extensions"],
  summary: "List all extensions",
  response: z.array(ExtensionResponseSchema),
  handler: async (_req, res) => {
    const extensions = await ctx.extensionCollection
      .find({ deletedAt: { $exists: false } })
      .toArray();
    extensions.sort((a, b) => a._id.localeCompare(b._id));
    res.json(extensions.map((e) => ({ ...e, id: e._id })));
  },
});

// GET /api/v1/extensions/search — search internal DB + VS Code marketplace
// MUST be defined before /:id to avoid being caught by the route param
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/extensions/search",
  tags: ["Extensions"],
  summary: "Search extensions (internal + marketplace)",
  query: z.object({ q: z.string(), limit: z.string().optional() }),
  response: z.array(ExtensionSearchResultSchema),
  errorResponses: {
    400: { description: "Missing query parameter" },
  },
  handler: async (req, res, next) => {
    try {
      const { q, limit: limitStr } = req.query;

      if (!q || typeof q !== "string" || !q.trim()) {
        res.status(400).json({ error: "Query parameter 'q' is required" });
        return;
      }

      const limit = Math.min(Math.max(parseInt(limitStr as string, 10) || 10, 1), 50);
      const query = q.trim();

      // Search internal DB (case-insensitive regex)
      const regex = { $regex: query, $options: "i" };
      const internalExtensions = await ctx.extensionCollection
        .find({
          deletedAt: { $exists: false },
          $or: [
            { _id: regex },
            { name: regex },
            { publisher: regex },
            { description: regex },
          ],
        })
        .limit(limit)
        .toArray();

      const internalResults: ExtensionSearchResult[] = internalExtensions.map((e) => ({
        id: e._id,
        name: e.name,
        publisher: e.publisher,
        description: e.description,
        internal: true,
      }));

      const internalIds = new Set(internalExtensions.map((e) => e._id));

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
  tags: ["Extensions"],
  summary: "Get extension by ID",
  params: z.object({ id: z.string() }),
  response: ExtensionResponseSchema,
  handler: async (req, res) => {
    const extension = await ctx.extensionCollection.findOne({
      _id: req.params.id,
      deletedAt: { $exists: false },
    });
    if (!extension) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }
    res.json({ ...extension, id: extension._id });
  },
});

// POST /api/v1/extensions — create/import extension (upserts if soft-deleted)
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/extensions",
  tags: ["Extensions"],
  summary: "Create or import an extension",
  body: CreateExtensionInputSchema,
  response: ExtensionResponseSchema,
  handler: async (req, res) => {
    const { _id, publisher, name, description, origin } = req.body;
    const now = new Date();
    const existing = await ctx.extensionCollection.findOne({ _id });

    if (existing) {
      await ctx.extensionCollection.updateOne(
        { _id },
        {
          $set: {
            publisher,
            name,
            ...(description !== undefined ? { description } : {}),
            origin,
            updatedAt: now,
          },
          $unset: { deletedAt: "" },
        },
      );
      const updated = await ctx.extensionCollection.findOne({ _id });
      res.json({ ...updated, id: updated!._id });
    } else {
      const extensionDoc: ExtensionDocument = {
        _id,
        publisher,
        name,
        ...(description ? { description } : {}),
        origin,
        createdAt: now,
      };
      await ctx.extensionCollection.insertOne(extensionDoc);
      res.status(201).json({ ...extensionDoc, id: extensionDoc._id });
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
  body: UpdateExtensionInputSchema,
  response: ExtensionResponseSchema,
  handler: async (req, res) => {
    const { id } = req.params;
    const { name, description } = req.body;

    const existing = await ctx.extensionCollection.findOne({
      _id: id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updateFields.name = name;
    if (description !== undefined) updateFields.description = description;

    await ctx.extensionCollection.updateOne({ _id: id }, { $set: updateFields });
    const updated = await ctx.extensionCollection.findOne({ _id: id });
    res.json({ ...updated, id: updated!._id });
  },
});

// DELETE /api/v1/extensions/:id — soft-delete extension
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/extensions/:id",
  tags: ["Extensions"],
  summary: "Delete extension",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  handler: async (req, res) => {
    const { id } = req.params;

    const existing = await ctx.extensionCollection.findOne({
      _id: id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }

    await ctx.extensionCollection.updateOne(
      { _id: id },
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
