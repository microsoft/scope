// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { pipeline } from "stream/promises";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { BulkCreateReportsInputSchema, BulkReportStatusInputSchema, BulkReportSummaryInputSchema, BulkReportSummaryResponseSchema, BulkTriggerReportsInputSchema, CreateReportInputSchema, InsightResponseSchema, ReportResponseSchema, TriggerReportsInputSchema } from "@scope/core";
import { evaluateTrigger } from "@scope/platform";
import type { TaskPromptDocument } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type {
  InsightReference,
  ReportDocument,
  RequestDocument,
  RouteContext,
} from "../route-context.js";
import { subscribeClient, unsubscribeClient } from "../utils/sse.js";
import type { SSEClient } from "../utils/sse.js";

export function registerReportsRoutes(ctx: RouteContext): void {

// ==================== Report Endpoints ====================

// Create a report for a run (POST /api/v1/reports)
// Accepts optional templateId to associate the report with a report template.
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/reports",
  tags: ["Reports"],
  summary: "Create report",
  body: CreateReportInputSchema,
  response: ReportResponseSchema,
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
    404: { description: "Run or template not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestId, templateId } = req.body;

      if (!requestId || typeof requestId !== "string") {
        res.status(400).json({ error: "requestId is required and must be a string" });
        return;
      }

      // Verify the run exists
      const run = await ctx.requestCollection.findOne({ _id: requestId });
      if (!run) {
        res.status(404).json({ error: `Run ${requestId} not found` });
        return;
      }

      // Verify the template exists (if specified)
      if (templateId) {
        const template = await ctx.reportTemplateCollection.findOne({ id: templateId, deletedAt: { $exists: false } });
        if (!template) {
          res.status(404).json({ error: `Report template '${templateId}' not found` });
          return;
        }
      }

      const reportId = uuidv4();

      const reportDoc: ReportDocument = {
        _id: reportId,
        requestId,
        ...(templateId ? { templateId } : {}),
        status: "pending",
        createdAt: new Date(),
      };

      await ctx.reportCollection.insertOne(reportDoc);

      // Queue the report for processing
      const messageContent = Buffer.from(JSON.stringify({ reportId })).toString("base64");
      await ctx.reportQueueClient.sendMessage(messageContent);

      console.log(`Created report ${reportId} for run ${requestId}${templateId ? ` (template: ${templateId})` : ""} and queued for processing`);

      res.status(201).json({
        id: reportId,
        requestId,
        ...(templateId ? { templateId } : {}),
        status: "pending",
        message: "Report generation queued",
      });
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/reports",
  tags: ["Reports"],
  summary: "List reports",
  query: z.object({ requestId: z.string().optional() }),
  response: z.array(ReportResponseSchema),
  handler: async (req, res, next) => {
    try {
      const requestIdFilter = req.query.requestId as string;
      const filter: Record<string, unknown> = {};
      if (requestIdFilter) {
        filter.requestId = requestIdFilter;
      }

      const reports = await ctx.reportCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      // Enrich reports with the task from their associated run
      const requestIds = [...new Set(reports.map(r => r.requestId))];
      const runs = requestIds.length > 0
        ? await ctx.requestCollection.find({ _id: { $in: requestIds } as any }, { projection: { _id: 1, "scenario.task": 1 } }).toArray()
        : [];
      const taskByRequestId = new Map(runs.map(r => [r._id, r.scenario?.task]));

      res.json(reports.map(r => ({ ...r, id: r._id, task: taskByRequestId.get(r.requestId) })));
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/reports/bulk-create",
  tags: ["Reports"],
  summary: "Bulk create reports",
  body: BulkCreateReportsInputSchema,
  response: z.array(ReportResponseSchema),
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestIds } = req.body as { requestIds?: string[] };

      if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
        res.status(400).json({ error: "requestIds must be a non-empty array of strings" });
        return;
      }

      // Verify all runs exist
      const runs = await ctx.requestCollection.find({ _id: { $in: requestIds } as any }).toArray();
      const foundIds = new Set(runs.map(r => r._id));
      const notFound = requestIds.filter(id => !foundIds.has(id));

      // Create reports only for runs that exist
      const validIds = requestIds.filter(id => foundIds.has(id));
      const created: { reportId: string; requestId: string }[] = [];

      for (const requestId of validIds) {
        const reportId = uuidv4();
        const reportDoc: ReportDocument = {
          _id: reportId,
          requestId,
          status: "pending",
          createdAt: new Date(),
        };
        await ctx.reportCollection.insertOne(reportDoc);

        const messageContent = Buffer.from(JSON.stringify({ reportId })).toString("base64");
        await ctx.reportQueueClient.sendMessage(messageContent);

        created.push({ reportId, requestId });
      }

      console.log(`Bulk created ${created.length} reports for ${validIds.length} runs`);

      res.status(201).json({
        created: created.length,
        reports: created,
        notFound,
      });
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/reports/bulk-status",
  tags: ["Reports"],
  summary: "Bulk get report statuses",
  body: BulkReportStatusInputSchema,
  response: z.array(ReportResponseSchema),
  errorResponses: {
    400: { description: "Invalid input" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestIds } = req.body as { requestIds?: string[] };

      if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
        res.status(400).json({ error: "requestIds must be a non-empty array of strings" });
        return;
      }

      // Find the latest report for each requestId
      const reports = await ctx.reportCollection
        .find({ requestId: { $in: requestIds } })
        .sort({ createdAt: -1 })
        .toArray();

      // Build a map of requestId → latest report status
      const statusMap: Record<string, { reportId: string; status: string }> = {};
      for (const report of reports) {
        if (!statusMap[report.requestId]) {
          statusMap[report.requestId] = {
            reportId: report._id,
            status: report.status,
          };
        }
      }

      res.json(statusMap);
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/reports/bulk-summary",
  tags: ["Reports"],
  summary: "Bulk get report summary per run",
  description: "Returns aggregated report status counts per run. Only the latest report per template is counted (re-triggers are deduplicated).",
  body: BulkReportSummaryInputSchema,
  response: BulkReportSummaryResponseSchema,
  errorResponses: {
    400: { description: "Invalid input" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestIds } = req.body as { requestIds?: string[] };

      if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
        res.status(400).json({ error: "requestIds must be a non-empty array of strings" });
        return;
      }

      // Aggregation: group by (requestId, templateId), keep latest status per
      // template, then roll up into per-requestId status counts.
      const pipeline = [
        { $match: { requestId: { $in: requestIds } } },
        { $sort: { createdAt: -1 as const } },
        // Keep only the latest report per (requestId, templateId)
        {
          $group: {
            _id: { requestId: "$requestId", templateId: { $ifNull: ["$templateId", ""] } },
            status: { $first: "$status" },
          },
        },
        // Roll up into per-requestId status counts
        {
          $group: {
            _id: "$_id.requestId",
            total: { $sum: 1 },
            pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
            generating: { $sum: { $cond: [{ $eq: ["$status", "generating"] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          },
        },
      ];

      const results = await ctx.reportCollection.aggregate(pipeline).toArray();

      const summaryMap: Record<string, { total: number; pending: number; generating: number; completed: number; failed: number }> = {};
      for (const row of results) {
        summaryMap[row._id as string] = {
          total: row.total,
          pending: row.pending,
          generating: row.generating,
          completed: row.completed,
          failed: row.failed,
        };
      }

      res.json(summaryMap);
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/reports/:id",
  tags: ["Reports"],
  summary: "Get report",
  params: z.object({ id: z.string() }),
  response: ReportResponseSchema,
  errorResponses: {
    404: { description: "Report not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;

      const report = await ctx.reportCollection.findOne({ _id: id });

      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      res.json({ ...report, id: report._id });
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/reports/:id/logs",
  tags: ["Reports"],
  summary: "Stream report logs (SSE)",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Server-sent event stream of log entries",
  errorResponses: {
    404: { description: "Report not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const fromStart = req.query.fromStart === "true";

      const report = await ctx.reportCollection.findOne({ _id: id });

      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Replay existing logs from blob storage if requested
      if (fromStart) {
        try {
          const pastLogs = await ctx.blobStorage.getLogEvents(id);
          for (const log of pastLogs) {
            res.write(`data: ${JSON.stringify(log)}\n\n`);
          }
        } catch (err) {
          console.error(`Failed to replay logs for report ${id}:`, err);
          res.write(`event: error\ndata: ${JSON.stringify({ message: "Cannot connect to log storage" })}\n\n`);
          res.end();
          return;
        }
      }

      // If report already completed/failed, send done and close
      if (report.status === "completed" || report.status === "failed") {
        res.write(`event: done\ndata: {"status":"${report.status}"}\n\n`);
        res.end();
        return;
      }

      // Live streaming via Redis + Change Streams (same pattern as requests)
      let cleaned = false;
      let changeStream: ReturnType<typeof ctx.reportCollection.watch> | null = null;
      let redisSubscribed = false;

      const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
      let inactivityTimer: ReturnType<typeof setTimeout>;

      const resetInactivityTimer = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          res.write(`event: timeout\ndata: {"message":"Stream timeout after 5 minutes of inactivity"}\n\n`);
          client.cleanup();
        }, INACTIVITY_TIMEOUT_MS);
      };

      const heartbeat = setInterval(() => {
        if (!cleaned) {
          res.write(`:\n\n`);
        }
      }, 30_000);

      const client: SSEClient = {
        res,
        onActivity: resetInactivityTimer,
        cleanup: () => {
          if (!cleaned) {
            cleaned = true;
            clearTimeout(inactivityTimer);
            clearInterval(heartbeat);
            if (changeStream) {
              changeStream.close().catch(err => console.error("Error closing report change stream:", err));
            }
            if (redisSubscribed) {
              unsubscribeClient(id, client);
            }
            res.end();
          }
        },
      };

      resetInactivityTimer();

      if (process.env.REDIS_HOST) {
        try {
          await subscribeClient(id, client);
          redisSubscribed = true;
        } catch (err) {
          console.error(`Redis subscription failed for report ${id}, using Change Streams only:`, err);
        }
      }

      try {
        changeStream = ctx.reportCollection.watch(
          [{ $match: { "documentKey._id": id, operationType: "update" } }],
          { fullDocument: "updateLookup" }
        );

        changeStream.on("change", (change) => {
          if (change.operationType === "update" && change.fullDocument) {
            const doc = change.fullDocument;
            if (doc.status === "completed" || doc.status === "failed") {
              res.write(`event: done\ndata: {"status":"${doc.status}"}\n\n`);
              client.cleanup();
            }
          }
        });

        changeStream.on("error", (err) => {
          console.error(`Report change stream error for ${id}:`, err);
        });
      } catch (err) {
        console.error(`Failed to create change stream for report ${id}:`, err);
      }

      req.on("close", () => client.cleanup());
    } catch (error) {
      next(error);
    }
  },
});

// POST /api/v1/reports/trigger — evaluate all report templates' triggers for a completed run
// Called by coding agent workers after a run completes. Creates a report per matching template.
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/reports/trigger",
  tags: ["Reports"],
  summary: "Trigger reports",
  body: TriggerReportsInputSchema,
  response: z.object({ triggered: z.number(), reports: z.array(ReportResponseSchema) }),
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
    404: { description: "Run not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestId } = req.body;

      if (!requestId || typeof requestId !== "string") {
        res.status(400).json({ error: "requestId is required and must be a string" });
        return;
      }

      // Fetch the completed run
      const run = await ctx.requestCollection.findOne({ _id: requestId });
      if (!run) {
        res.status(404).json({ error: `Run ${requestId} not found` });
        return;
      }

      // Fetch task prompt document (needed for promptFeature trigger evaluation)
      let taskPrompt: TaskPromptDocument | null = null;
      if (run.taskPromptId) {
        taskPrompt = await ctx.taskPromptCollection.findOne({ _id: run.taskPromptId });
      }

      // Load all active report templates
      const templates = await ctx.reportTemplateCollection
        .find({ deletedAt: { $exists: false } })
        .toArray();

      // Evaluate each template's trigger against the run
      const created: Array<{ id: string; requestId: string; templateId: string; status: string }> = [];

      for (const template of templates) {
        // Cast the run to the shared RequestDocument shape for evaluateTrigger
        const triggerResult = evaluateTrigger(
          template.trigger as any,
          run as any,
          taskPrompt as any
        );

        if (triggerResult) {
          const reportId = uuidv4();
          const reportDoc: ReportDocument = {
            _id: reportId,
            requestId,
            templateId: template.id,
            status: "pending",
            createdAt: new Date(),
          };
          await ctx.reportCollection.insertOne(reportDoc);
          const messageContent = Buffer.from(JSON.stringify({ reportId })).toString("base64");
          await ctx.reportQueueClient.sendMessage(messageContent);

          created.push({ id: reportId, requestId, templateId: template.id, status: "pending" });
          console.log(`Trigger matched template '${template.id}' — created report ${reportId} for run ${requestId}`);
        }
      }

      console.log(`Trigger evaluation for run ${requestId}: ${created.length}/${templates.length} templates matched`);
      res.status(201).json({ triggered: created.length, reports: created });
    } catch (error) {
      next(error);
    }
  },
});

// POST /api/v1/reports/bulk-trigger — evaluate report templates for multiple runs at once
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/reports/bulk-trigger",
  tags: ["Reports"],
  summary: "Bulk trigger reports",
  body: BulkTriggerReportsInputSchema,
  response: z.array(z.object({}).passthrough()),
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestIds } = req.body as { requestIds?: string[] };

      if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
        res.status(400).json({ error: "requestIds must be a non-empty array of strings" });
        return;
      }

      // Fetch runs
      const runs = await ctx.requestCollection.find({ _id: { $in: requestIds } as any }).toArray();
      const foundIds = new Set(runs.map(r => r._id));
      const notFound = requestIds.filter(id => !foundIds.has(id));

      // Load all active templates
      const templates = await ctx.reportTemplateCollection
        .find({ deletedAt: { $exists: false } })
        .toArray();

      const created: Array<{ reportId: string; requestId: string; templateId: string }> = [];

      for (const run of runs) {
        // Fetch task prompt for trigger evaluation
        let taskPrompt: TaskPromptDocument | null = null;
        if (run.taskPromptId) {
          taskPrompt = await ctx.taskPromptCollection.findOne({ _id: run.taskPromptId });
        }

        for (const template of templates) {
          const triggerResult = evaluateTrigger(
            template.trigger as any,
            run as any,
            taskPrompt as any
          );

          if (triggerResult) {
            const reportId = uuidv4();
            const reportDoc: ReportDocument = {
              _id: reportId,
              requestId: run._id,
              templateId: template.id,
              status: "pending",
              createdAt: new Date(),
            };
            await ctx.reportCollection.insertOne(reportDoc);
            const messageContent = Buffer.from(JSON.stringify({ reportId })).toString("base64");
            await ctx.reportQueueClient.sendMessage(messageContent);
            created.push({ reportId, requestId: run._id, templateId: template.id });
          }
        }
      }

      console.log(`Bulk trigger: created ${created.length} reports for ${runs.length} runs`);

      res.status(201).json({
        created: created.length,
        reports: created,
        notFound,
      });
    } catch (error) {
      next(error);
    }
  },
});

// Get insights referenced by a specific report
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/reports/:id/insights",
  tags: ["Reports"],
  summary: "Get insights for report",
  params: z.object({ id: z.string() }),
  response: z.array(InsightResponseSchema.extend({
    referencedAt: z.coerce.date().optional(),
    isNew: z.boolean().optional(),
  })),
  errorResponses: {
    404: { description: "Report not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const report = await ctx.reportCollection.findOne({ _id: id });
      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      if (!report.insightReferences || report.insightReferences.length === 0) {
        res.json([]);
        return;
      }

      const insightIds = report.insightReferences.map((ref: InsightReference) => ref.insightId);
      const insights = await ctx.insightsCollection
        .find({ _id: { $in: insightIds }, deletedAt: { $exists: false } })
        .toArray();

      // Enrich with reference metadata
      const enriched = insights.map((insight) => {
        const ref = report.insightReferences!.find((r: InsightReference) => r.insightId === insight._id);
        return {
          ...insight,
          id: insight._id,
          referencedAt: ref?.referencedAt,
          isNew: ref?.isNew,
        };
      });

      res.json(enriched);
    } catch (error) {
      next(error);
    }
  },
});

// Add an insight reference to a report
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/reports/:id/insights",
  tags: ["Reports"],
  summary: "Link insight to report",
  params: z.object({ id: z.string() }),
  body: z.object({
    insightId: z.string(),
    isNew: z.boolean().optional(),
  }),
  response: z.object({
    insightId: z.string(),
    referencedAt: z.coerce.date(),
    isNew: z.boolean(),
  }),
  errorResponses: {
    404: { description: "Report or insight not found" },
    409: { description: "Insight already referenced by this report" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { insightId, isNew } = req.body;

      if (!insightId || typeof insightId !== "string") {
        res.status(400).json({ error: "insightId is required" });
        return;
      }

      const report = await ctx.reportCollection.findOne({ _id: id });
      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      const insight = await ctx.insightsCollection.findOne({ _id: insightId, deletedAt: { $exists: false } });
      if (!insight) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      // Check if already referenced
      const alreadyReferenced = report.insightReferences?.some((ref: InsightReference) => ref.insightId === insightId);
      if (alreadyReferenced) {
        res.status(409).json({ error: "Insight already referenced by this report" });
        return;
      }

      const reference: InsightReference = {
        insightId,
        referencedAt: new Date(),
        isNew: isNew === true,
      };

      // Add reference to report
      await ctx.reportCollection.updateOne(
        { _id: id },
        { $push: { insightReferences: reference }, $set: { updatedAt: new Date() } }
      );

      // Increment reference count on insight
      await ctx.insightsCollection.updateOne(
        { _id: insightId },
        { $inc: { referenceCount: 1 }, $set: { updatedAt: new Date() } }
      );

      res.status(201).json(reference);
    } catch (error) {
      next(error);
    }
  },
});

}
