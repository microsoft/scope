// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { z } from "zod";
import { ExperimentStore, type ExperimentRequestState } from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import {
  ProjectIdQuerySchema,
  getQueryProjectId,
} from "../utils/project-scope.js";
import { resolveRunForRequest } from "./requests/resolve-run.js";

const gunzipAsync = promisify(gunzip);

const TaxonomyReadoutReferenceSchema = z
  .object({
    status: z.enum(["processing", "done", "failed"]),
    experimentExecutionId: z.string(),
    taxonomyRevisionId: z.string(),
    jsonUrl: z.string().optional(),
    markdownUrl: z.string().optional(),
    updatedAt: z.coerce.date(),
    error: z.string().optional(),
  })
  .openapi("TaxonomyReadoutReference");

function experimentStore(ctx: RouteContext): ExperimentStore {
  return new ExperimentStore({
    experiments: ctx.experimentCollection,
    executions: ctx.experimentExecutionsCollection,
    chunks: ctx.experimentChunksCollection,
  });
}

async function requireEnabled(ctx: RouteContext): Promise<boolean> {
  return Boolean(
    await ctx.featureFlagCollection.findOne({
      key: "taxonome",
      enabled: true,
    }),
  );
}

function renderMarkdown(readout: {
  experimentId: string;
  experimentExecutionId: string;
  taxonomyRef: string;
  runs: Array<{ requestId: string; runId: string; state: string }>;
}): string {
  const counts = new Map<string, number>();
  for (const run of readout.runs) {
    counts.set(run.state, (counts.get(run.state) ?? 0) + 1);
  }
  const lines = [
    "# Taxonome readout",
    "",
    `- Experiment: \`${readout.experimentId}\``,
    `- Execution: \`${readout.experimentExecutionId}\``,
    `- Taxonomy: \`${readout.taxonomyRef}\``,
    `- Runs: ${readout.runs.length}`,
    "",
    "## States",
    "",
    ...[...counts.entries()].map(([state, count]) => `- ${state}: ${count}`),
    "",
    "## Exact runs",
    "",
    "| Request | Run | State |",
    "|---|---|---|",
    ...readout.runs.map(
      (run) => `| \`${run.requestId}\` | \`${run.runId}\` | ${run.state} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

export async function buildTaxonomyReadout(
  ctx: RouteContext,
  input: {
    projectId: string;
    experimentId: string;
    executionId: string;
    requests: ExperimentRequestState[];
    taxonomy: {
      taxonomyRevisionId: string;
      ref: string;
      contentSha256: string;
    };
  },
) {
  const runs: Array<Record<string, unknown>> = [];
  for (const pair of input.requests) {
    const resolved = await resolveRunForRequest(
      ctx,
      pair.requestId,
      pair.runId,
    );
    if ("error" in resolved) {
      runs.push({
        requestId: pair.requestId,
        runId: pair.runId,
        state: "missing",
      });
      continue;
    }
    const handler = resolved.run.handlerStatus?.["pp-taxonomy"];
    if (handler?.status === "failed") {
      runs.push({
        requestId: pair.requestId,
        runId: pair.runId,
        state: "runtime-failure",
        error: handler.error,
      });
      continue;
    }
    const reference = resolved.run.taxonomyEvaluation;
    if (!reference) {
      runs.push({
        requestId: pair.requestId,
        runId: pair.runId,
        state: "missing",
      });
      continue;
    }
    const compressed = await ctx.blobStorage.downloadBuffer(reference.url);
    const body = await gunzipAsync(compressed);
    const hash = createHash("sha256").update(body).digest("hex");
    if (hash !== reference.contentSha256) {
      runs.push({
        requestId: pair.requestId,
        runId: pair.runId,
        state: "runtime-failure",
        error: "Taxonomy evaluation integrity check failed",
      });
      continue;
    }
    const result: unknown = JSON.parse(body.toString("utf8"));
    runs.push({
      requestId: pair.requestId,
      runId: pair.runId,
      state: "completed",
      result,
    });
  }
  return {
    schemaVersion: "scope/taxonomy-experiment-readout/v1",
    projectId: input.projectId,
    experimentId: input.experimentId,
    experimentExecutionId: input.executionId,
    taxonomy: input.taxonomy,
    runs,
    generatedAt: new Date().toISOString(),
  };
}

/** Registers typed Taxonome readout status, generation, content, and download routes. */
export function registerTaxonomyReadoutRoutes(ctx: RouteContext): void {
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/experiments/:id/taxonomy-readout",
    tags: ["Experiments"],
    summary: "Get typed Taxonome readout status",
    query: ProjectIdQuerySchema,
    response: TaxonomyReadoutReferenceSchema,
    handler: async (req, res, next) => {
      try {
        if (!(await requireEnabled(ctx))) {
          res.status(404).json({ error: "Taxonome is not enabled" });
          return;
        }
        const experiment = await experimentStore(ctx).get(
          getQueryProjectId(req),
          req.params.id,
        );
        if (!experiment?.execution.taxonomyReadout) {
          res.status(404).json({ error: "Taxonome readout not available" });
          return;
        }
        res.json(experiment.execution.taxonomyReadout);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/experiments/:id/taxonomy-readout/retry",
    tags: ["Experiments"],
    summary: "Generate or retry the typed Taxonome readout",
    query: ProjectIdQuerySchema,
    response: TaxonomyReadoutReferenceSchema,
    successStatus: 202,
    handler: async (req, res, next) => {
      const projectId = getQueryProjectId(req);
      const store = experimentStore(ctx);
      const claimToken = randomUUID();
      try {
        if (!(await requireEnabled(ctx))) {
          res.status(404).json({ error: "Taxonome is not enabled" });
          return;
        }
        const experiment = await store.get(projectId, req.params.id);
        const taxonomy = experiment?.execution.taxonomy;
        if (!experiment || !taxonomy) {
          res.status(404).json({ error: "Taxonomy-enabled Experiment not found" });
          return;
        }
        const claim = await ctx.experimentCollection.findOneAndUpdate(
          {
            _id: experiment._id,
            projectId,
            "execution.experimentExecutionId":
              experiment.execution.experimentExecutionId,
            "execution.version": experiment.execution.version,
          },
          {
            $set: {
              "execution.taxonomyReadout": {
                status: "processing",
                claimToken,
                experimentExecutionId:
                  experiment.execution.experimentExecutionId,
                taxonomyRevisionId: taxonomy.taxonomyRevisionId,
                updatedAt: new Date(),
              },
            },
            $inc: { "execution.version": 1 },
          },
          { returnDocument: "after" },
        );
        if (!claim) {
          res.status(409).json({ error: "Experiment execution changed" });
          return;
        }
        const requests = await store.readExecutionRequests({
          projectId,
          experimentId: experiment.experimentId,
          experimentExecutionId: experiment.execution.experimentExecutionId,
        });
        if (!requests) throw new Error("Experiment request vector is unavailable");
        const readout = await buildTaxonomyReadout(ctx, {
          projectId,
          experimentId: experiment.experimentId,
          executionId: experiment.execution.experimentExecutionId,
          requests,
          taxonomy,
        });
        const prefix =
          `${experiment.experimentId}/executions/` +
          `${experiment.execution.experimentExecutionId}/taxonomy-readout/${claimToken}`;
        const jsonUrl = await ctx.blobStorage.uploadJson(
          `${prefix}/readout.json`,
          readout,
        );
        const markdownUrl = await ctx.blobStorage.uploadText(
          `${prefix}/readout.md`,
          renderMarkdown(readout as never),
          "text/markdown; charset=utf-8",
        );
        const completed = {
          status: "done" as const,
          experimentExecutionId: experiment.execution.experimentExecutionId,
          taxonomyRevisionId: taxonomy.taxonomyRevisionId,
          jsonUrl,
          markdownUrl,
          updatedAt: new Date(),
        };
        const publication = await ctx.experimentCollection.updateOne(
          {
            _id: experiment._id,
            projectId,
            "execution.experimentExecutionId":
              experiment.execution.experimentExecutionId,
            "execution.taxonomyReadout.claimToken": claimToken,
          },
          { $set: { "execution.taxonomyReadout": completed } },
        );
        if (publication.matchedCount !== 1) {
          res.status(409).json({ error: "Experiment execution changed" });
          return;
        }
        res.status(202).json(completed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.experimentCollection.updateOne(
          {
            _id: req.params.id,
            projectId,
            "execution.taxonomyReadout.claimToken": claimToken,
          },
          {
            $set: {
              "execution.taxonomyReadout.status": "failed",
              "execution.taxonomyReadout.error": message,
              "execution.taxonomyReadout.updatedAt": new Date(),
            },
          },
        );
        next(error);
      }
    },
  });

  for (const format of ["json", "markdown"] as const) {
    apiRoute(ctx.app, ctx.registry, {
      method: "get",
      path: `/api/v1/experiments/:id/taxonomy-readout/${format}`,
      tags: ["Experiments"],
      summary: `Download Taxonome readout ${format}`,
      query: ProjectIdQuerySchema,
      response: z.any(),
      rawResponse: true,
      handler: async (req, res, next) => {
        try {
          if (!(await requireEnabled(ctx))) {
            res.status(404).json({ error: "Taxonome is not enabled" });
            return;
          }
          const experiment = await experimentStore(ctx).get(
            getQueryProjectId(req),
            req.params.id,
          );
          const reference = experiment?.execution.taxonomyReadout;
          const url = format === "json" ? reference?.jsonUrl : reference?.markdownUrl;
          if (!url) {
            res.status(404).json({ error: "Taxonome readout not available" });
            return;
          }
          const body = await ctx.blobStorage.downloadBuffer(url);
          res
            .type(format === "json" ? "application/json" : "text/markdown")
            .send(body);
        } catch (error) {
          next(error);
        }
      },
    });
  }
}
