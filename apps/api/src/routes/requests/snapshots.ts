// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

import type { RouteContext } from "../../route-context.js";
import { downloadBlobToResponse } from "./blob-helpers.js";
import { registerArtifactRoutes } from "./artifact-route.js";

export function registerRequestsSnapshotsRoutes(ctx: RouteContext): void {
  registerArtifactRoutes(ctx, {
    path: "snapshots/:iteration",
    summary: "Download iteration snapshot",
    perRunSummary: "Download iteration snapshot for a specific attempt",
    responseDescription: "Gzipped snapshot archive",
    extraParams: z.object({ iteration: z.string() }),
    blobNotFoundMessage: "Snapshot not found — the blob may have been deleted or is no longer available",
    handler: async (ctx, req, res, targetRun, id) => {
      const iteration = req.params.iteration;
      const iterNum = parseInt(iteration, 10);
      if (isNaN(iterNum) || iterNum < 1) {
        res.status(400).json({ error: "Invalid iteration number" });
        return;
      }

      const turn = targetRun.turns?.find((t: { iteration: number }) => t.iteration === iterNum);
      if (!turn?.snapshotUrl) {
        res.status(404).json({ error: `No snapshot for iteration ${iterNum}` });
        return;
      }

      await downloadBlobToResponse(ctx, res, turn.snapshotUrl, {
        contentType: "application/gzip",
        filename: `${id}-iteration-${iterNum}.tar.gz`,
        label: "snapshot",
      });
    },
  });
}
