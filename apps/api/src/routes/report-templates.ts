// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { join, basename } from "path";
import { z } from "zod";
import { CreateReportTemplateInputSchema, ReportTemplateResponseSchema, UpdateReportTemplateInputSchema } from "@scope/core";
import { REPORT_SYSTEM_PROMPT } from "@scope/platform";
import { apiRoute } from "../openapi/api-route.js";
import type { ReportTemplateDocument, RouteContext } from "../route-context.js";
import { validateTrigger } from "../utils/validate-trigger.js";

export function registerReportTemplatesRoutes(ctx: RouteContext): void {

// ============================================================
// Report Template CRUD routes (/api/v1/report-templates)
// ============================================================

// Get the default system prompt used when no template override is set
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/report-templates/default-system-prompt",
  tags: ["Report Templates"],
  summary: "Get default system prompt",
  response: z.object({ content: z.string() }),
  handler: (_req, res) => {
    res.json({ content: REPORT_SYSTEM_PROMPT });
  },
});

// List models available for report generation (github-copilot provider)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/report-templates/available-models",
  tags: ["Report Templates"],
  summary: "List models available for report generation",
  response: z.array(z.object({ modelId: z.string() })),
  handler: async (_req, res, next) => {
    try {
      const models = await ctx.modelCollection.find({ provider: "github-copilot", disappearedAt: { $exists: false } }).toArray();
      const result = models.map(m => ({ modelId: m._id.split(":").slice(1).join(":") }));
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
});

// List all report templates
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/report-templates",
  tags: ["Report Templates"],
  summary: "List report templates",
  query: z.object({ q: z.string().optional() }),
  response: z.array(ReportTemplateResponseSchema),
  handler: async (req, res, next) => {
    try {
      const q = req.query.q as string | undefined;
      const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
      if (q) {
        filter.$or = [
          { id: { $regex: q, $options: "i" } },
          { name: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
        ];
      }
      const templates = await ctx.reportTemplateCollection.find(filter).toArray();
      templates.sort((a, b) => a.id.localeCompare(b.id));
      res.json(templates);
    } catch (error) {
      next(error);
    }
  },
});

// Get single report template by ID
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/report-templates/:id",
  tags: ["Report Templates"],
  summary: "Get report template",
  params: z.object({ id: z.string() }),
  response: ReportTemplateResponseSchema,
  errorResponses: {
    404: { description: "Report template not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const template = await ctx.reportTemplateCollection.findOne({ id, deletedAt: { $exists: false } });
      if (!template) {
        res.status(404).json({ error: `Report template '${id}' not found` });
        return;
      }
      res.json(template);
    } catch (error) {
      next(error);
    }
  },
});

// Create a report template
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/report-templates",
  tags: ["Report Templates"],
  summary: "Create report template",
  body: CreateReportTemplateInputSchema,
  response: ReportTemplateResponseSchema,
  errorResponses: {
    409: { description: "Report template already exists" },
  },
  handler: async (req, res, next) => {
    try {
      const { id, name, description, userPrompt, systemPrompt, trigger, model, timeoutMs } = req.body;

      if (!id || typeof id !== "string") {
        res.status(400).json({ error: "id is required and must be a string" });
        return;
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
        res.status(400).json({ error: "id must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores" });
        return;
      }
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required and must be a string" });
        return;
      }
      if (!userPrompt || typeof userPrompt !== "string") {
        res.status(400).json({ error: "userPrompt is required and must be a string" });
        return;
      }

      // Validate systemPrompt if provided
      if (systemPrompt !== undefined) {
        if (!systemPrompt || typeof systemPrompt !== "object") {
          res.status(400).json({ error: "systemPrompt must be an object with 'mode' and 'content'" });
          return;
        }
        if (!["append", "override"].includes(systemPrompt.mode)) {
          res.status(400).json({ error: "systemPrompt.mode must be 'append' or 'override'" });
          return;
        }
        if (!systemPrompt.content || typeof systemPrompt.content !== "string") {
          res.status(400).json({ error: "systemPrompt.content is required and must be a string" });
          return;
        }
      }

      // Validate trigger if provided
      if (trigger !== undefined) {
        const triggerError = validateTrigger(trigger);
        if (triggerError) {
          res.status(400).json({ error: triggerError });
          return;
        }
      }

      // Validate model against available github-copilot provider models
      if (model !== undefined) {
        const available = await ctx.modelCollection.find({ provider: "github-copilot", disappearedAt: { $exists: false } }).toArray();
        const validIds = available.map(m => m._id.split(":").slice(1).join(":"));
        if (!validIds.includes(model)) {
          res.status(400).json({ error: `Invalid model "${model}". Available models: ${validIds.join(", ")}` });
          return;
        }
      }

      // Check for duplicate id
      const existing = await ctx.reportTemplateCollection.findOne({ id });
      if (existing && !existing.deletedAt) {
        res.status(409).json({ error: `Report template '${id}' already exists` });
        return;
      }

      const now = new Date();

      if (existing && existing.deletedAt) {
        // Un-delete: update the soft-deleted document
        await ctx.reportTemplateCollection.updateOne(
          { id },
          {
            $set: {
              name,
              ...(description !== undefined ? { description } : {}),
              userPrompt,
              ...(systemPrompt !== undefined ? { systemPrompt } : {}),
              ...(trigger !== undefined ? { trigger } : {}),
              ...(model !== undefined ? { model } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              updatedAt: now,
            },
            $unset: { deletedAt: "" },
          }
        );
        const updated = await ctx.reportTemplateCollection.findOne({ id });
        res.status(201).json(updated);
      } else {
        const templateDoc: ReportTemplateDocument = {
          id,
          name,
          ...(description ? { description } : {}),
          userPrompt,
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(trigger ? { trigger } : {}),
          ...(model ? { model } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
          createdAt: now,
        };
        await ctx.reportTemplateCollection.insertOne(templateDoc as any);
        res.status(201).json(templateDoc);
      }
    } catch (error) {
      next(error);
    }
  },
});

// Update a report template
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/report-templates/:id",
  tags: ["Report Templates"],
  summary: "Update report template",
  params: z.object({ id: z.string() }),
  body: UpdateReportTemplateInputSchema,
  response: ReportTemplateResponseSchema,
  errorResponses: {
    404: { description: "Report template not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { name, description, userPrompt, systemPrompt, trigger, model, timeoutMs } = req.body;

      const existing = await ctx.reportTemplateCollection.findOne({ id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: `Report template '${id}' not found` });
        return;
      }

      const updateFields: Record<string, unknown> = { updatedAt: new Date() };
      if (name !== undefined) updateFields.name = name;
      if (description !== undefined) updateFields.description = description;
      if (userPrompt !== undefined) {
        if (typeof userPrompt !== "string" || !userPrompt.trim()) {
          res.status(400).json({ error: "userPrompt must be a non-empty string" });
          return;
        }
        updateFields.userPrompt = userPrompt;
      }
      if (systemPrompt !== undefined) {
        if (systemPrompt === null) {
          // Allow removing systemPrompt by setting to null
          updateFields.systemPrompt = undefined;
        } else {
          if (!["append", "override"].includes(systemPrompt.mode)) {
            res.status(400).json({ error: "systemPrompt.mode must be 'append' or 'override'" });
            return;
          }
          if (!systemPrompt.content || typeof systemPrompt.content !== "string") {
            res.status(400).json({ error: "systemPrompt.content is required and must be a string" });
            return;
          }
          updateFields.systemPrompt = systemPrompt;
        }
      }
      if (trigger !== undefined) {
        if (trigger === null) {
          // Allow removing trigger (reverts to "always" behavior)
          updateFields.trigger = undefined;
        } else {
          const triggerError = validateTrigger(trigger);
          if (triggerError) {
            res.status(400).json({ error: triggerError });
            return;
          }
          updateFields.trigger = trigger;
        }
      }
      if (model !== undefined) {
        if (model === null) {
          // Allow removing model (reverts to global REPORT_MODEL)
          updateFields.model = undefined;
        } else {
          const available = await ctx.modelCollection.find({ provider: "github-copilot", disappearedAt: { $exists: false } }).toArray();
          const validIds = available.map(m => m._id.split(":").slice(1).join(":"));
          if (!validIds.includes(model)) {
            res.status(400).json({ error: `Invalid model "${model}". Available models: ${validIds.join(", ")}` });
            return;
          }
          updateFields.model = model;
        }
      }
      if (timeoutMs !== undefined) {
        if (timeoutMs === null) {
          updateFields.timeoutMs = undefined;
        } else {
          updateFields.timeoutMs = timeoutMs;
        }
      }

      await ctx.reportTemplateCollection.updateOne({ id }, { $set: updateFields });
      const updated = await ctx.reportTemplateCollection.findOne({ id });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },
});

// Delete a report template (soft-delete)
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/report-templates/:id",
  tags: ["Report Templates"],
  summary: "Delete report template",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  errorResponses: {
    404: { description: "Report template not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;

      const existing = await ctx.reportTemplateCollection.findOne({ id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: `Report template '${id}' not found` });
        return;
      }

      await ctx.reportTemplateCollection.updateOne(
        { id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } }
      );

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

}
