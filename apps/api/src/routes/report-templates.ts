// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  CreateReportTemplateInputSchema,
  REPORT_SYSTEM_PROMPT,
  ReportTemplateResponseSchema,
  ReportTemplateStore,
  ReportTemplateVersionResponseSchema,
  UpdateReportTemplateInputSchema,
  type ReportTrigger,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import {
  ProjectIdQuerySchema,
  getQueryProjectId,
} from "../utils/project-scope.js";

function store(ctx: RouteContext): ReportTemplateStore {
  return new ReportTemplateStore({
    templates: ctx.reportTemplateCollection,
    versions: ctx.reportTemplateVersionCollection,
  });
}

async function validateLinkedRunTemplates(input: {
  ctx: RouteContext;
  projectId: string;
  trigger?: ReportTrigger | null;
}): Promise<string[]> {
  if (input.trigger?.type !== "run-report-templates") return [];
  const ids = [...new Set(input.trigger.reportTemplateIds)].sort();
  const templates = await input.ctx.reportTemplateCollection
    .find({
      projectId: input.projectId,
      id: { $in: ids },
      subject: "run",
      enabled: true,
      deletedAt: { $exists: false },
    })
    .project({ id: 1 })
    .toArray();
  const valid = new Set(templates.map((template) => template.id));
  return ids.filter((id) => !valid.has(id));
}

export function registerReportTemplatesRoutes(ctx: RouteContext): void {
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

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/report-templates/available-models",
    tags: ["Report Templates"],
    summary: "List models available for report generation",
    response: z.array(z.object({ modelId: z.string() })),
    handler: async (_req, res, next) => {
      try {
        const models = await ctx.modelCollection
          .find({
            provider: "github-copilot",
            disappearedAt: { $exists: false },
          })
          .toArray();
        res.json(
          models.map((model) => ({
            modelId: model._id.split(":").slice(1).join(":"),
          })),
        );
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/report-templates",
    tags: ["Report Templates"],
    summary: "List report templates",
    query: ProjectIdQuerySchema.extend({
      q: z.string().optional(),
      subject: z.enum(["run", "experiment"]).optional(),
      includeDisabled: z.coerce.boolean().default(false),
    }),
    response: z.array(ReportTemplateResponseSchema),
    handler: async (req, res, next) => {
      try {
        const templates = await store(ctx).list({
          projectId: getQueryProjectId(req),
          subject: req.query.subject as "run" | "experiment" | undefined,
          includeDisabled: req.query.includeDisabled === true,
        });
        const query = (req.query.q as string | undefined)?.toLowerCase();
        res.json(
          query
            ? templates.filter((template) =>
                `${template.id} ${template.name} ${template.description ?? ""}`
                  .toLowerCase()
                  .includes(query),
              )
            : templates,
        );
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/report-templates/:id",
    tags: ["Report Templates"],
    summary: "Get report template",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    response: ReportTemplateResponseSchema,
    errorResponses: { 404: { description: "Report template not found" } },
    handler: async (req, res, next) => {
      try {
        const template = await store(ctx).get(
          getQueryProjectId(req),
          req.params.id,
        );
        if (!template) {
          res.status(404).json({
            error: `Report template '${req.params.id}' not found`,
          });
          return;
        }
        res.json(template);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/report-templates/:id/versions",
    tags: ["Report Templates"],
    summary: "List immutable report template versions",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    response: z.array(ReportTemplateVersionResponseSchema),
    handler: async (req, res, next) => {
      try {
        res.json(
          await store(ctx).listVersions(
            getQueryProjectId(req),
            req.params.id,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/report-templates/:id/versions/:versionId",
    tags: ["Report Templates"],
    summary: "Get an exact immutable report template version",
    params: z.object({ id: z.string(), versionId: z.string() }),
    query: ProjectIdQuerySchema,
    response: ReportTemplateVersionResponseSchema,
    errorResponses: { 404: { description: "Template version not found" } },
    handler: async (req, res, next) => {
      try {
        const version = await store(ctx).getVersion({
          projectId: getQueryProjectId(req),
          templateId: req.params.id,
          versionId: req.params.versionId,
        });
        if (!version) {
          res.status(404).json({ error: "Report template version not found" });
          return;
        }
        res.json(version);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/report-templates",
    tags: ["Report Templates"],
    summary: "Create a versioned report template",
    body: CreateReportTemplateInputSchema,
    query: ProjectIdQuerySchema,
    response: ReportTemplateResponseSchema,
    successStatus: 201,
    errorResponses: {
      400: { description: "Invalid template or linked run templates" },
      409: { description: "Report template already exists" },
    },
    handler: async (req, res, next) => {
      try {
        const projectId = getQueryProjectId(req);
        const invalidLinkedIds = await validateLinkedRunTemplates({
          ctx,
          projectId,
          trigger: req.body.trigger,
        });
        if (invalidLinkedIds.length > 0) {
          res.status(400).json({
            error: "Invalid linked run report templates",
            code: "invalid-linked-run-report-templates",
            invalidTemplateIds: invalidLinkedIds,
          });
          return;
        }
        const created = await store(ctx).create({
          projectId,
          ...req.body,
        });
        res.status(201).json(created);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("already exists")
        ) {
          res.status(409).json({ error: error.message });
          return;
        }
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "put",
    path: "/api/v1/report-templates/:id",
    tags: ["Report Templates"],
    summary: "Update a report template and append immutable content versions",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    body: UpdateReportTemplateInputSchema,
    response: ReportTemplateResponseSchema,
    errorResponses: {
      400: { description: "Invalid template or linked run templates" },
      404: { description: "Report template not found" },
      409: { description: "Concurrent template update" },
    },
    handler: async (req, res, next) => {
      try {
        const projectId = getQueryProjectId(req);
        const existing = await store(ctx).get(projectId, req.params.id);
        if (!existing) {
          res.status(404).json({
            error: `Report template '${req.params.id}' not found`,
          });
          return;
        }
        const nextTrigger =
          req.body.trigger === undefined
            ? existing.trigger
            : req.body.trigger;
        const invalidLinkedIds = await validateLinkedRunTemplates({
          ctx,
          projectId,
          trigger: nextTrigger,
        });
        if (invalidLinkedIds.length > 0) {
          res.status(400).json({
            error: "Invalid linked run report templates",
            code: "invalid-linked-run-report-templates",
            invalidTemplateIds: invalidLinkedIds,
          });
          return;
        }
        const updated = await store(ctx).update(
          projectId,
          req.params.id,
          req.body,
        );
        res.json(updated);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("changed concurrently")
        ) {
          res.status(409).json({ error: error.message });
          return;
        }
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "delete",
    path: "/api/v1/report-templates/:id",
    tags: ["Report Templates"],
    summary: "Soft-delete a report template",
    params: z.object({ id: z.string() }),
    query: ProjectIdQuerySchema,
    response: z.object({ message: z.string() }),
    successStatus: 204,
    errorResponses: { 404: { description: "Report template not found" } },
    handler: async (req, res, next) => {
      try {
        const deleted = await store(ctx).softDelete(
          getQueryProjectId(req),
          req.params.id,
        );
        if (!deleted) {
          res.status(404).json({
            error: `Report template '${req.params.id}' not found`,
          });
          return;
        }
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  });
}
