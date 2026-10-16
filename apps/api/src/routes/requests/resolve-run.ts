// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RouteContext, RequestDocument } from "../../route-context.js";
import { getHistoricalRun } from "../../runs-repo.js";
import type { RunState } from "shared";

/**
 * Resolve a specific RunState by runId — checks the current request.run
 * first, then falls back to the historical runs collection.
 */
export async function resolveRunForRequest(
  ctx: RouteContext,
  requestId: string,
  runId: string,
  options: { projectId?: string; excludeDeleted?: boolean } = {},
): Promise<{ run: RunState; request: RequestDocument } | { error: string; status: number }> {
  const request = await ctx.requestCollection.findOne({
    _id: requestId,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.excludeDeleted ? { deletedAt: { $exists: false } } : {}),
  });
  if (!request || (options.excludeDeleted && request.deletedAt) ||
      (options.projectId && request.projectId !== options.projectId)) {
    return { error: "Request not found", status: 404 };
  }
  if (request.run?._id === runId) {
    return { run: request.run, request };
  }
  const historical = await getHistoricalRun({ runsCollection: ctx.runsCollection }, runId);
  if (!historical || historical.requestId !== requestId ||
      (options.projectId && historical.projectId !== options.projectId)) {
    return { error: "Run not found for this request", status: 404 };
  }
  return { run: historical, request };
}
