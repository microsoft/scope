// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RouteContext, RequestDocument } from "../../route-context.js";
import { getHistoricalRun } from "../../runs-repo.js";
import type { RunState } from "@scope/core";

/**
 * Resolve a specific RunState by runId — checks the current request.run
 * first, then falls back to the historical runs collection.
 */
export async function resolveRunForRequest(
  ctx: RouteContext,
  requestId: string,
  runId: string,
): Promise<{ run: RunState; request: RequestDocument } | { error: string; status: number }> {
  const request = await ctx.requestCollection.findOne({ _id: requestId });
  if (!request) {
    return { error: "Request not found", status: 404 };
  }
  if (request.run?._id === runId) {
    return { run: request.run, request };
  }
  const historical = await getHistoricalRun({ runsCollection: ctx.runsCollection }, runId);
  if (!historical || historical.requestId !== requestId) {
    return { error: "Run not found for this request", status: 404 };
  }
  return { run: historical, request };
}
