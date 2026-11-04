// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RouteContext } from "../../route-context.js";
import { downloadBlobToResponse } from "./blob-helpers.js";
import { registerArtifactRoutes } from "./artifact-route.js";

export function registerRequestsTaxonomyRoutes(ctx: RouteContext): void {
  registerArtifactRoutes(ctx, {
    path: "taxonomy",
    summary: "Download taxonomy JSON for the run",
    perRunSummary: "Download taxonomy JSON for a specific attempt",
    responseDescription: "Taxonomy v1 JSON document (scorecard, behavior analysis, action list)",
    errorResponses: { 404: { description: "Not found — taxonomy not yet generated" } },
    blobNotFoundMessage: "Taxonomy file not found — the blob may have been deleted or is no longer available",
    handler: async (ctx, _req, res, targetRun, id) => {
      const taxonomyUrl = targetRun.taxonomyUrl;
      if (!taxonomyUrl) {
        res.status(404).json({ error: "Taxonomy not yet generated for this run" });
        return;
      }

      await downloadBlobToResponse(ctx, res, taxonomyUrl, {
        contentType: "application/json",
        filename: `${id}-taxonomy.json`,
        label: "Taxonomy",
      });
    },
  });
}
