// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { CreateInsightInputSchema, InsightResponseSchema, ReportResponseSchema, UpdateInsightInputSchema } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { InsightDocument, RouteContext } from "../route-context.js";

export function registerInsightsRoutes(ctx: RouteContext): void {

// =====================================================================
// Insights API (apiRoute)
// =====================================================================

// List all insights (with optional ?q= text search, ?blocked= filter)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/insights",
  tags: ["Insights"],
  summary: "List insights",
  query: z.object({
    q: z.string().optional(),
    blocked: z.string().optional(),
  }),
  response: z.array(InsightResponseSchema),
  handler: async (req, res, next) => {
    try {
      const { q, blocked } = req.query;
      const filter: Record<string, unknown> = { deletedAt: { $exists: false } };

      if (blocked !== undefined) {
        filter.blocked = blocked === "true";
      }

      if (q && typeof q === "string" && q.trim()) {
        // Case-insensitive regex search across title, description, category, and tags
        const regex = { $regex: q.trim(), $options: "i" };
        filter.$or = [
          { title: regex },
          { description: regex },
          { category: regex },
          { tags: regex },
        ];
      }

      const insights = await ctx.insightsCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(insights.map((i) => ({ ...i, id: i._id })));
    } catch (error) {
      next(error);
    }
  },
});

// Search insights by keyword (fuzzy regex match)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/insights/search",
  tags: ["Insights"],
  summary: "Search insights",
  query: z.object({
    q: z.string(),
    blocked: z.string().optional(),
  }),
  response: z.array(InsightResponseSchema),
  handler: async (req, res, next) => {
    try {
      const { q, blocked } = req.query;

      if (!q || typeof q !== "string" || !q.trim()) {
        res.status(400).json({ error: "Query parameter 'q' is required" });
        return;
      }

      const filter: Record<string, unknown> = { deletedAt: { $exists: false } };

      if (blocked !== undefined) {
        filter.blocked = blocked === "true";
      } else {
        // Default: exclude blocked insights from search
        filter.blocked = { $ne: true };
      }

      // Split query into words and match all of them (AND) across title/description/tags
      const words = q.trim().split(/\s+/);
      filter.$and = words.map((word) => {
        const regex = { $regex: word, $options: "i" };
        return {
          $or: [
            { title: regex },
            { description: regex },
            { category: regex },
            { tags: regex },
          ],
        };
      });

      const insights = await ctx.insightsCollection
        .find(filter)
        .sort({ referenceCount: -1, createdAt: -1 })
        .limit(20)
        .toArray();

      res.json(insights.map((i) => ({ ...i, id: i._id })));
    } catch (error) {
      next(error);
    }
  },
});

// Get a single insight
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/insights/:id",
  tags: ["Insights"],
  summary: "Get insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const insight = await ctx.insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!insight) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }
      res.json({ ...insight, id: insight._id });
    } catch (error) {
      next(error);
    }
  },
});

// Create a new insight
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/insights",
  tags: ["Insights"],
  summary: "Create insight",
  body: CreateInsightInputSchema,
  response: InsightResponseSchema,
  handler: async (req, res, next) => {
    try {
      const { title, description, category, tags, createdBy, sourceReportId } = req.body;

      if (!title || typeof title !== "string" || !title.trim()) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      if (!description || typeof description !== "string" || !description.trim()) {
        res.status(400).json({ error: "description is required" });
        return;
      }

      const now = new Date();
      const doc: InsightDocument = {
        _id: uuidv4(),
        title: title.trim(),
        description: description.trim(),
        category: category?.trim() || undefined,
        tags: Array.isArray(tags) ? tags.map((t: string) => t.trim()).filter(Boolean) : undefined,
        upvotes: 0,
        downvotes: 0,
        blocked: false,
        referenceCount: 0,
        createdBy: createdBy === "agent" ? "agent" : "user",
        sourceReportId: sourceReportId || undefined,
        createdAt: now,
      };

      await ctx.insightsCollection.insertOne(doc);
      res.status(201).json({ ...doc, id: doc._id });
    } catch (error) {
      next(error);
    }
  },
});

// Update an insight
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/insights/:id",
  tags: ["Insights"],
  summary: "Update insight",
  params: z.object({ id: z.string() }),
  body: UpdateInsightInputSchema,
  response: InsightResponseSchema,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await ctx.insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      const { title, description, category, tags } = req.body;
      const updateFields: Record<string, unknown> = { updatedAt: new Date() };

      if (title !== undefined) updateFields.title = title.trim();
      if (description !== undefined) updateFields.description = description.trim();
      if (category !== undefined) updateFields.category = category?.trim() || undefined;
      if (tags !== undefined) updateFields.tags = Array.isArray(tags) ? tags.map((t: string) => t.trim()).filter(Boolean) : undefined;

      await ctx.insightsCollection.updateOne({ _id: id }, { $set: updateFields });
      const updated = await ctx.insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Soft-delete an insight
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/insights/:id",
  tags: ["Insights"],
  summary: "Delete insight",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await ctx.insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await ctx.insightsCollection.updateOne(
        { _id: id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } }
      );
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

// Upvote an insight
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/insights/:id/upvote",
  tags: ["Insights"],
  summary: "Upvote insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  successStatus: 200,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await ctx.insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await ctx.insightsCollection.updateOne({ _id: id }, { $inc: { upvotes: 1 }, $set: { updatedAt: new Date() } });
      const updated = await ctx.insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Downvote an insight
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/insights/:id/downvote",
  tags: ["Insights"],
  summary: "Downvote insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  successStatus: 200,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await ctx.insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await ctx.insightsCollection.updateOne({ _id: id }, { $inc: { downvotes: 1 }, $set: { updatedAt: new Date() } });
      const updated = await ctx.insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Block an insight
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/insights/:id/block",
  tags: ["Insights"],
  summary: "Block insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  successStatus: 200,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await ctx.insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await ctx.insightsCollection.updateOne({ _id: id }, { $set: { blocked: true, updatedAt: new Date() } });
      const updated = await ctx.insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Unblock an insight
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/insights/:id/unblock",
  tags: ["Insights"],
  summary: "Unblock insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  successStatus: 200,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await ctx.insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await ctx.insightsCollection.updateOne({ _id: id }, { $set: { blocked: false, updatedAt: new Date() } });
      const updated = await ctx.insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Get reports that reference a specific insight
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/insights/:id/reports",
  tags: ["Insights"],
  summary: "Get reports referencing insight",
  params: z.object({ id: z.string() }),
  response: z.array(ReportResponseSchema),
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const insight = await ctx.insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!insight) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      const reports = await ctx.reportCollection
        .find({ "insightReferences.insightId": id })
        .sort({ createdAt: -1 })
        .toArray();

      res.json(reports.map((r) => ({ ...r, id: r._id })));
    } catch (error) {
      next(error);
    }
  },
});

}
