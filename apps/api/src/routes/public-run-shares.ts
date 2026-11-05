// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RestError } from "@azure/storage-blob";
import { z } from "zod";
import type { Request, Response, RequestHandler } from "express";
import { LogEventSchema, withRetry, type RunState } from "shared";
import {
  RUN_SHARE_HEADER, SharedRunSchema, SharedRunReportsSchema, type SharedRun,
} from "shared/run-sharing";
import { apiRoute } from "../openapi/api-route.js";
import type { RequestDocument, RouteContext } from "../route-context.js";
import { isRunSharingEnabled, shareRateLimit, shareResponseHeaders } from "../run-sharing/guards.js";
import { scopedShareBlobName, sendSharedArtifact } from "../run-sharing/blob-access.js";
import { projectSharedRun, sharedArtifacts } from "../run-sharing/projection.js";
import { RunShareStore, type RunShareDocument } from "../run-sharing/store.js";
import { createBlobServiceClient } from "./requests/blob-helpers.js";
import { resolveRunForRequest } from "./requests/resolve-run.js";

const basePath = "/api/v1/shared/runs";
const unavailable = { error: "Shared run is unavailable" };
const emptyQuery = z.object({}).strict();
const pageQuery = z.object({ after: z.string().uuid().optional() }).strict();
const publicSecurity = [{ runShareToken: [] }];

interface SharedTarget {
  share: RunShareDocument;
  request: RequestDocument;
  run: RunState;
}
type PublicRead = (req: Request, res: Response, target: SharedTarget) => Promise<void>;

export function registerPublicRunShareRoutes(ctx: RouteContext): void {
  ctx.registry.registerComponent("securitySchemes", "runShareToken", {
    type: "apiKey", in: "header", name: RUN_SHARE_HEADER,
    description: "Secret from the fragment of a shared run URL. Grants only the link's selected read access.",
  });
  ctx.app.use(basePath, shareResponseHeaders, shareRateLimit(), (req, res, next) => {
    if (!isRunSharingEnabled()) res.status(404).json(unavailable);
    else if ((req.headers["content-length"] && req.headers["content-length"] !== "0") ||
        req.headers["transfer-encoding"]) {
      res.status(400).json({ error: "Shared-run reads do not accept a request body" });
    }
    else next();
  });

  function read(handler: PublicRead): RequestHandler {
    return async (req, res) => {
      let shareId: string | undefined;
      try {
        const token = req.header(RUN_SHARE_HEADER);
        const store = new RunShareStore(ctx.db.collection<RunShareDocument>("run-shares"));
        const share = token ? await store.resolve(token) : null;
        if (!share) {
          res.status(404).json(unavailable);
          return;
        }
        shareId = share._id;
        const resolved = await resolveRunForRequest(ctx, share.requestId, share.runId, {
          projectId: share.projectId, excludeDeleted: true,
        });
        const project = await withRetry(() => ctx.projectCollection.findOne({
          _id: share.projectId, deletedAt: { $exists: false },
        }));
        if ("error" in resolved || !project || project.deletedAt) {
          res.status(404).json(unavailable);
          return;
        }
        await handler(req, res, { share, request: resolved.request, run: resolved.run });
      } catch (error) {
        if (res.headersSent) {
          console.error("Shared run stream interrupted", { shareId });
          res.destroy();
          return;
        }
        if (error instanceof RestError && error.statusCode === 404) {
          res.status(404).json({ error: "Shared content is unavailable" });
          return;
        }
        // Never log a request, header, storage URL, or raw transport error here.
        console.error("Shared run read failed", {
          shareId, errorType: error instanceof Error ? error.name : "unknown",
        });
        res.status(503).json({ error: "Unable to load shared content; try again later" });
      }
    };
  }

  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: `${basePath}/view`, tags: ["Run sharing"], summary: "View the content permitted by a public run link",
    security: publicSecurity, query: emptyQuery, response: SharedRunSchema,
    errorResponses: { 404: { description: "Link unavailable" }, 429: { description: "Rate limited" } },
    handler: read(async (_req, res, { share, request, run }) => {
      let prompts: SharedRun["prompts"];
      if (share.content.prompts) {
        prompts = [{ label: "Task", text: request.scenario.task }];
        if (request.personaInstructions) prompts.push({ label: "Persona instructions", text: request.personaInstructions });
        if (request.persona) prompts.push({ label: "Persona", text: JSON.stringify(request.persona, null, 2) });
        const references = [
          ...(request.agentsMdPromptId ? [{ id: request.agentsMdPromptId, label: "AGENTS.md" }] : []),
          ...(request.gates ?? []).filter((gate) => !!gate.promptId).map((gate) => ({
            id: gate.promptId!, label: `${gate.gate} gate`,
          })),
        ];
        const resolved = await Promise.all(references.map(async (ref) => {
          const prompt = await withRetry(() => ctx.taskPromptStore.get(ref.id));
          return {
            label: ref.label,
            text: prompt?.projectId === share.projectId
              ? await ctx.taskPromptStore.resolvePromptText(prompt) : null,
          };
        }));
        prompts.push(...resolved);
      }
      res.json(projectSharedRun(share, request, run, prompts));
    }),
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: `${basePath}/reports`, tags: ["Run sharing"], summary: "Read reports verified as belonging to the shared attempt",
    security: publicSecurity, query: pageQuery, response: SharedRunReportsSchema,
    handler: read(async (req, res, { share }) => {
      if (!share.content.reports) {
        res.status(404).json({ error: "Reports are not shared" });
        return;
      }
      const after = typeof req.query.after === "string" ? req.query.after : undefined;
      const reports = await withRetry(() => ctx.reportCollection.find({
        requestId: share.requestId, projectId: share.projectId,
        runId: share.runId, sourceRunId: share.runId, status: "completed",
        ...(after ? { _id: { $gt: after } } : {}),
      }).sort({ _id: 1 }).limit(11).toArray());
      res.json({
        data: reports.slice(0, 10).map((report) => {
          if (report.content === undefined) throw new Error("Completed shared report has no content");
          return {
            id: report._id, label: report.templateId ?? report.reporter?.name ?? "Report",
            content: report.content, createdAt: report.createdAt.toISOString(),
          };
        }),
        next: reports.length > 10 ? reports[9]._id : null,
      });
    }),
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: `${basePath}/logs`, tags: ["Run sharing"], summary: "Read up to the last 1 MiB of persisted shared run logs",
    security: publicSecurity, query: emptyQuery,
    response: z.object({ events: z.array(LogEventSchema), truncated: z.boolean() }),
    handler: read(async (_req, res, { share, run }) => {
      if (!share.content.logs) {
        res.status(404).json({ error: "Logs are not shared" });
        return;
      }
      const url = run.logsUrl ?? ctx.blobStorage.getLogsBlobUrl(`${share.requestId}/runs/${share.runId}/run.jsonl`);
      const name = scopedShareBlobName(url, "logs", share, run);
      if (!name) {
        res.status(404).json({ error: "Logs cannot be attributed to this attempt" });
        return;
      }
      const blob = createBlobServiceClient(ctx).getContainerClient("logs").getBlockBlobClient(name);
      const properties = await blob.getProperties();
      const bytes = properties.contentLength;
      if (bytes === undefined) throw new Error("Shared logs have no content length");
      const offset = Math.max(0, bytes - 1024 * 1024);
      const download = await blob.download(offset, bytes - offset || undefined);
      if (!download.readableStreamBody) throw new Error("Shared logs have no stream");
      const chunks: Buffer[] = [];
      let received = 0;
      const stream: AsyncIterable<unknown> = download.readableStreamBody;
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array) && typeof chunk !== "string") throw new Error("Shared logs returned an invalid data chunk");
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > 1024 * 1024) throw new Error("Shared logs exceeded the requested byte limit");
        chunks.push(buffer);
      }
      let text = Buffer.concat(chunks).toString("utf8");
      if (offset) {
        const boundary = text.indexOf("\n");
        text = boundary === -1 ? "" : text.slice(boundary + 1);
      }
      const lines = text.split("\n").filter((line) => line.trim());
      // A live append blob can end in an incomplete line; never parse it as JSON.
      const unfinished = !text.endsWith("\n") && run.status !== "done";
      if (unfinished) lines.pop();
      const events = lines.map((line) => {
        const value: unknown = JSON.parse(line);
        return LogEventSchema.parse(value);
      });
      res.json({ events, truncated: offset > 0 || unfinished });
    }),
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get", path: `${basePath}/artifacts/:artifactId`, tags: ["Run sharing"], summary: "Download an explicitly shared artifact (128 MiB maximum)",
    security: publicSecurity, params: z.object({ artifactId: z.string().min(1).max(100) }),
    query: emptyQuery, response: z.unknown(), rawResponse: true,
    errorResponses: { 404: { description: "Artifact not shared or unavailable" }, 413: { description: "Artifact too large" }, 416: { description: "Invalid byte range" } },
    handler: read(async (req, res, { share, run }) => {
      const artifact = sharedArtifacts(share, run).find((item) => item.id === req.params.artifactId);
      if (!artifact) {
        res.status(404).json({ error: "Artifact is not shared or unavailable" });
        return;
      }
      await sendSharedArtifact(ctx, req, res, share, run, artifact);
    }),
  });

  // Keep unsupported methods and child paths out of the authenticated router.
  ctx.app.use(basePath, (_req, res) => { res.status(404).json(unavailable); });
}
