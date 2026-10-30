// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { TaxonomyRunResultResponseSchema } from "shared";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";
import { resolveRunForRequest } from "./resolve-run.js";

const TaxonomyEvaluationReferenceSchema = z
  .object({
    url: z.string(),
    schemaVersion: z.string(),
    contentSha256: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .openapi("TaxonomyEvaluationReference");

const configuredMaxBytes = Number(process.env.TAXONOMY_RESULT_MAX_BYTES);
const MAX_TAXONOMY_RESULT_BYTES =
  Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
    ? Math.floor(configuredMaxBytes)
    : 10 * 1024 * 1024;

async function enabled(ctx: RouteContext): Promise<boolean> {
  return Boolean(
    await ctx.featureFlagCollection.findOne({
      key: "taxonome",
      enabled: true,
    }),
  );
}

/** Registers exact-run Taxonome result metadata and stable blob proxy routes. */
export function registerRequestsTaxonomyEvaluationRoutes(
  ctx: RouteContext,
): void {
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/requests/:id/runs/:runId/taxonomy-evaluation",
    tags: ["Requests"],
    summary: "Get the exact-run Taxonome result reference",
    response: TaxonomyEvaluationReferenceSchema,
    handler: async (req, res, next) => {
      try {
        if (!(await enabled(ctx))) {
          res.status(404).json({ error: "Taxonome is not enabled" });
          return;
        }
        const resolved = await resolveRunForRequest(
          ctx,
          req.params.id,
          req.params.runId,
        );
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        if (!resolved.run.taxonomyEvaluation) {
          res.status(404).json({ error: "Taxonomy evaluation not available" });
          return;
        }
        res.json(resolved.run.taxonomyEvaluation);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/requests/:id/runs/:runId/taxonomy-evaluation/json",
    tags: ["Requests"],
    summary: "Get the validated exact-run Taxonome result JSON",
    response: TaxonomyRunResultResponseSchema,
    handler: async (req, res, next) => {
      try {
        if (!(await enabled(ctx))) {
          res.status(404).json({ error: "Taxonome is not enabled" });
          return;
        }
        const resolved = await resolveRunForRequest(
          ctx,
          req.params.id,
          req.params.runId,
        );
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const reference = resolved.run.taxonomyEvaluation;
        if (!reference) {
          res.status(404).json({ error: "Taxonomy evaluation not available" });
          return;
        }
        if (reference.sizeBytes > MAX_TAXONOMY_RESULT_BYTES) {
          res.status(413).json({ error: "Taxonomy evaluation exceeds the view limit" });
          return;
        }

        let compressed: Buffer;
        try {
          compressed = await ctx.blobStorage.downloadBuffer(reference.url);
        } catch {
          res.status(502).json({ error: "Taxonomy evaluation artifact is unavailable" });
          return;
        }

        let body: Buffer;
        try {
          body = gunzipSync(compressed, {
            maxOutputLength: MAX_TAXONOMY_RESULT_BYTES,
          });
        } catch {
          res.status(409).json({ error: "Taxonomy evaluation artifact is invalid" });
          return;
        }
        if (body.byteLength !== reference.sizeBytes) {
          res.status(409).json({ error: "Taxonomy evaluation size check failed" });
          return;
        }
        const hash = createHash("sha256").update(body).digest("hex");
        if (hash !== reference.contentSha256) {
          res.status(409).json({ error: "Taxonomy evaluation integrity check failed" });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          res.status(409).json({ error: "Taxonomy evaluation JSON is invalid" });
          return;
        }
        const result = TaxonomyRunResultResponseSchema.safeParse(parsed);
        if (!result.success) {
          res.status(409).json({ error: "Taxonomy evaluation schema is invalid" });
          return;
        }
        res.json(result.data);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/requests/:id/runs/:runId/taxonomy-evaluation/content",
    tags: ["Requests"],
    summary: "Download the exact-run compressed Taxonome result",
    response: z.any(),
    rawResponse: true,
    handler: async (req, res, next) => {
      try {
        if (!(await enabled(ctx))) {
          res.status(404).json({ error: "Taxonome is not enabled" });
          return;
        }
        const resolved = await resolveRunForRequest(
          ctx,
          req.params.id,
          req.params.runId,
        );
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const reference = resolved.run.taxonomyEvaluation;
        if (!reference) {
          res.status(404).json({ error: "Taxonomy evaluation not available" });
          return;
        }
        const body = await ctx.blobStorage.downloadBuffer(reference.url);
        res
          .type("application/json")
          .set("Content-Encoding", "gzip")
          .set(
            "Content-Disposition",
            `attachment; filename="taxonomy-${req.params.runId}.json.gz"`,
          )
          .send(body);
      } catch (error) {
        next(error);
      }
    },
  });
}
